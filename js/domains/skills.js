// 技能分区：一份 JSON = { version: 1, skills: [{ name, description, platform, content, resources? }] }
// 对应插件侧「技能列表」（分组：技能）
//
// 可选顶层 includeDefaults: false = 不自动补入插件出厂默认技能（缺省/true 不输出）。
// 技能条目可选 resources = { 相对路径: 文本内容 }，只读参考，插件不执行。
import { DEFAULT_SKILLS } from './default-data.js';
import {
    baseName, fileName, isPlainObject, issue, looksBinary, normalizeText, parseDocument,
    parsePlatform, platformLabel, readCollection, splitFrontmatter, validateName,
    validatePlatform, validateVersion,
} from './common.js';

/** 单个资源内容超过这个长度只提示（仍完整保存） */
const MAX_RESOURCE_CHARS = 12000;
/** 单个技能超过这个资源数量只提示（仍完整保存） */
const MAX_RESOURCES = 50;
/** 资源路径最大长度（与插件侧校验一致） */
const MAX_RESOURCE_KEY_CHARS = 120;

/** 目录导入允许作为资源的文本扩展名；没有扩展名的文件也允许（如 Makefile） */
const RESOURCE_EXTENSIONS = new Set([
    'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'toml', 'csv', 'xml',
    'html', 'css', 'js', 'ts', 'py', 'sh', 'ini', 'cfg', 'conf',
]);

export function newSkill() {
    return { name: '', description: '', platform: [], content: '', resources: {}, enabled: true };
}

export function normalizeSkill(item, problems, path) {
    const src = item && typeof item === 'object' ? item : {};
    const platform = problems
        ? validatePlatform(src.platform, `${path}.platform`, problems)
        : parsePlatform(src.platform);
    const resources = isPlainObject(src.resources) ? { ...src.resources } : {};
    if (problems) {
        if (src.description !== undefined && src.description !== null && typeof src.description !== 'string') {
            problems.push(issue(`${path}.description`, 'description 必须是字符串'));
        }
        if (typeof src.content !== 'string') {
            problems.push(issue(`${path}.content`, 'content 必填（字符串）'));
        }
        if (src.resources !== undefined && src.resources !== null && !isPlainObject(src.resources)) {
            problems.push(issue(`${path}.resources`, 'resources 必须是对象（相对路径 → 文本内容）'));
        }
    }
    return {
        name: typeof src.name === 'string' ? src.name : '',
        description: typeof src.description === 'string' ? src.description : '',
        platform,
        content: typeof src.content === 'string' ? src.content : '',
        resources,
        enabled: src.enabled !== false,
    };
}

/** 归一化资源路径：统一用 /，去掉首尾空白（与插件侧一致） */
function normalizeResourceKey(key) {
    return String(key ?? '').trim().replace(/\\/g, '/');
}

/** 资源路径规则：非空、≤120、相对路径、无空段/./..、无控制字符（与插件侧一致） */
function resourceKeyProblem(key) {
    const normalized = normalizeResourceKey(key);
    if (!normalized) return '资源路径不能为空';
    if (normalized.length > MAX_RESOURCE_KEY_CHARS) return `资源路径不能超过 ${MAX_RESOURCE_KEY_CHARS} 字符`;
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return '资源路径不能是绝对路径';
    if (/[\u0000-\u001F\u007F]/.test(normalized)) return '资源路径不能含控制字符';
    if (normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
        return '资源路径不能含空段 / . / ..';
    }
    return '';
}

function resourceCount(item) {
    return isPlainObject(item.resources) ? Object.keys(item.resources).length : 0;
}

export function validateSkills(items) {
    const problems = [];
    const warnings = [];
    const names = [];
    items.forEach((item, i) => {
        if (item.enabled === false) return;
        const path = `$.skills[${i}]`;
        names.push(validateName(item.name, `${path}.name`, problems));
        if (typeof item.content !== 'string' || !item.content.trim()) {
            problems.push(issue(`${path}.content`, 'content 必填（技能正文）'));
        }
        if (typeof item.description !== 'string') {
            problems.push(issue(`${path}.description`, 'description 必须是字符串'));
        }
        if (!Array.isArray(item.platform)) {
            problems.push(issue(`${path}.platform`, 'platform 必须是数组'));
        } else {
            item.platform.forEach((p, j) => {
                if (typeof p !== 'string' || !p.trim()) problems.push(issue(`${path}.platform[${j}]`, '平台名必须是非空字符串'));
            });
        }
        if (String(item.content || '').length > 12000) {
            warnings.push(issue(`${path}.content`, '内容超过 12000 字符：use_skill 返回时插件会截断（仍会完整保存）'));
        }
        if (item.resources !== undefined && item.resources !== null) {
            if (!isPlainObject(item.resources)) {
                problems.push(issue(`${path}.resources`, 'resources 必须是对象（相对路径 → 文本内容）'));
            } else {
                const entries = Object.entries(item.resources);
                const seenKeys = new Set();
                for (const [key, value] of entries) {
                    const keyPath = `${path}.resources[${JSON.stringify(key)}]`;
                    const keyProblem = resourceKeyProblem(key);
                    if (keyProblem) problems.push(issue(keyPath, keyProblem));
                    const normalizedKey = normalizeResourceKey(key);
                    if (normalizedKey && seenKeys.has(normalizedKey)) {
                        problems.push(issue(keyPath, '资源路径归一化后重复'));
                    }
                    seenKeys.add(normalizedKey);
                    if (typeof value !== 'string' || !value.trim()) {
                        problems.push(issue(keyPath, '资源内容必须是非空字符串'));
                    } else if (value.length > MAX_RESOURCE_CHARS) {
                        warnings.push(issue(keyPath, `资源超过 ${MAX_RESOURCE_CHARS} 字符：只读参考，插件可能截断（仍会完整保存）`));
                    }
                }
                if (entries.length > MAX_RESOURCES) {
                    warnings.push(issue(`${path}.resources`, `资源数量 ${entries.length} 超过 ${MAX_RESOURCES} 个（仍会完整保存）`));
                }
            }
        }
    });
    for (const dup of duplicateNames(names)) {
        problems.push(issue('$.skills', `技能名重复：${dup}`));
    }
    return { problems, warnings };
}

export function buildSkills(items, options = {}) {
    const out = { version: 1 };
    // 只在显式关闭时输出：缺省 / true 时与旧版输出逐字一致
    if (options && options.includeDefaults === false) out.includeDefaults = false;
    out.skills = items.filter(item => item.enabled !== false).map(item => {
        const skill = { name: item.name.trim() };
        if (item.description && item.description.trim()) skill.description = item.description.trim();
        if (Array.isArray(item.platform) && item.platform.length > 0) skill.platform = item.platform;
        skill.content = item.content;
        if (resourceCount(item) > 0) {
            const resources = {};
            for (const [key, value] of Object.entries(item.resources)) {
                const normalizedKey = normalizeResourceKey(key);
                if (!normalizedKey) continue;
                // 用 defineProperty 而不是 obj[key]：资源名可能是 __proto__ 这类特殊键
                Object.defineProperty(resources, normalizedKey, {
                    value, enumerable: true, configurable: true, writable: true,
                });
            }
            if (Object.keys(resources).length > 0) skill.resources = resources;
        }
        return skill;
    });
    return out;
}

export function parseSkillsImport(text) {
    const parsed = parseDocument(text, 'skills', '技能配置');
    if (!parsed.ok) return { ok: false, issues: parsed.issues };
    const problems = [];
    validateVersion(parsed.value.version, problems);
    // includeDefaults：缺失/null = 不设置；存在时必须为布尔
    const hasIncludeDefaults = parsed.value.includeDefaults !== undefined && parsed.value.includeDefaults !== null;
    if (hasIncludeDefaults && typeof parsed.value.includeDefaults !== 'boolean') {
        problems.push(issue('$.includeDefaults', 'includeDefaults 必须是布尔值'));
    }
    const list = readCollection(parsed.value, 'skills', problems);
    const items = list.map((item, i) => normalizeSkill(item, problems, `$.skills[${i}]`));
    const result = validateSkills(items);
    problems.push(...result.problems);
    if (problems.length > 0) return { ok: false, issues: problems };
    const imported = { ok: true, items };
    if (hasIncludeDefaults) imported.options = { includeDefaults: parsed.value.includeDefaults };
    return imported;
}

/** .md 文件 → 一条技能；SKILL.md 的 frontmatter 是跨 agent 标准格式，继续支持。
 *  fallbackName 用于目录导入时以顶层目录名兜底技能名（避免多个 SKILL.md 都叫 SKILL）。 */
export function skillFromFile(filename, text, fallbackName) {
    const raw = normalizeText(text).trim();
    const file = String(filename ?? '').split(/[\\/]/).pop() || '(未命名)';
    if (!raw) return { ok: false, issues: [issue(`文件 ${file}`, '文件为空')] };
    const fm = splitFrontmatter(raw);
    const warnings = [];
    let name = '';
    let description = '';
    let platform = [];
    let content = raw;
    if (fm) {
        name = (fm.meta.name || '').trim();
        description = fm.meta.description || '';
        platform = fm.meta.platform || [];
        content = fm.body;
        if (!name) warnings.push(issue(`文件 ${file}`, 'frontmatter 没有 name，已用目录名/文件名代替'));
    } else {
        warnings.push(issue(`文件 ${file}`, '没有 --- frontmatter，已把整份内容作为技能正文（建议补 name/description）'));
    }
    if (!name) name = String(fallbackName || '').trim() || baseName(filename);
    if (!name) return { ok: false, issues: [issue(`文件 ${file}`, '无法确定技能名')] };
    if (!content) return { ok: false, issues: [issue(`文件 ${file}`, '技能正文为空')] };
    return { ok: true, item: { name, description, platform, content }, warnings };
}

function duplicateNames(names) {
    const seen = new Set();
    const dup = new Set();
    for (const raw of names) {
        const name = String(raw ?? '').trim();
        if (!name) continue;
        if (seen.has(name)) dup.add(name);
        seen.add(name);
    }
    return [...dup];
}

/** 目录导入：反斜杠归一化为 /，并去掉开头的 ./ 与 / */
function normalizeEntryPath(path) {
    return String(path ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
}

/** 扩展名（小写，不含点）；无扩展名返回空串 */
function extensionOf(name) {
    const base = String(name ?? '');
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 任一路径段以 . 开头 = 隐藏文件 / 目录（.git / .env / .DS_Store 等） */
function hasHiddenSegment(path) {
    return String(path).split('/').some(segment => segment.startsWith('.'));
}

/**
 * 技能目录导入：一个目录 = 一个技能。
 * files = [{ path, text }]，path 形如 `my-skill/SKILL.md`、`my-skill/references/forms.md`
 * （Windows 反斜杠会归一化成 /）。目录根下的 SKILL.md 提供 name/description/platform/content，
 * 其余文本文件按相对路径收进 resources（只读参考，插件不执行）。
 *
 * @returns {{ok:true, items:Array, warnings:Array} | {ok:false, issues:Array}}
 */
export function skillFromFiles(files) {
    const warnings = [];
    const groups = new Map();
    for (const entry of Array.isArray(files) ? files : []) {
        const path = normalizeEntryPath(entry && entry.path);
        if (!path) continue;
        const segments = path.split('/');
        const top = segments.length > 1 ? segments[0] : '';
        if (!groups.has(top)) groups.set(top, []);
        groups.get(top).push({
            path,
            relative: segments.length > 1 ? segments.slice(1).join('/') : path,
            text: normalizeText(entry && entry.text),
        });
    }
    const isSkillFile = file =>
        !file.relative.includes('/') && fileName(file.path).toLowerCase() === 'skill.md';
    const hasSkillFile = [...groups.values()].some(list => list.some(isSkillFile));
    if (!hasSkillFile) return { ok: false, issues: [issue('目录', '未找到 SKILL.md')] };

    // 根级 SKILL.md + references/**（浏览器给了相对路径但没有顶层目录）也是合法单技能输入：
    // 只有根组含 SKILL.md 时，把其余「无 SKILL.md 的顶层目录」作为根技能的资源并入，
    // 避免 references/forms.md 被误判为「缺少 SKILL.md 的子目录」而丢失。
    const rootGroup = groups.get('');
    const rootSkillFiles = rootGroup ? rootGroup.filter(isSkillFile) : [];
    const otherSkillGroups = [...groups.keys()].filter(top =>
        top !== '' && (groups.get(top) || []).some(isSkillFile));
    if (rootSkillFiles.length === 1 && otherSkillGroups.length === 0) {
        for (const top of [...groups.keys()]) {
            if (top === '') continue;
            const list = groups.get(top) || [];
            for (const file of list) {
                // 并入根组后，资源键使用完整相对路径（references/forms.md）
                rootGroup.push({ ...file, relative: file.path });
            }
            groups.delete(top);
        }
    }

    const items = [];
    const issues = [];
    for (const top of groups.keys()) {
        const list = groups.get(top);
        const skillFiles = list.filter(isSkillFile);
        if (skillFiles.length === 0) {
            // 根目录散文件（浏览器只给了 file.name）不是技能；有目录名的给出提示
            if (top) warnings.push(issue(`目录 ${top}`, '未找到 SKILL.md，已跳过'));
            continue;
        }
        const primary = skillFiles[0];
        if (skillFiles.length > 1) {
            warnings.push(issue(`目录 ${top || '.'}`, `找到 ${skillFiles.length} 个 SKILL.md，仅使用 ${primary.relative}`));
        }
        const parsed = skillFromFile(primary.path, primary.text, top || '');
        warnings.push(...(parsed.warnings || []));
        if (!parsed.ok) {
            issues.push(...(parsed.issues || []));
            continue;
        }

        const resources = {};
        // 保持输入顺序；同一相对路径只收第一份（确定性跳过后者，不静默覆盖）
        const resourceFiles = list
            .filter(file => file !== primary && fileName(file.path).toLowerCase() !== 'skill.md');
        for (const file of resourceFiles) {
            if (hasHiddenSegment(file.relative)) continue;
            const ext = extensionOf(fileName(file.relative));
            if (ext && !RESOURCE_EXTENSIONS.has(ext)) {
                warnings.push(issue(`文件 ${file.path}`, `不支持的文件类型（.${ext}），已跳过`));
                continue;
            }
            if (looksBinary(file.text)) {
                warnings.push(issue(`文件 ${file.path}`, '疑似二进制内容，已跳过'));
                continue;
            }
            if (!file.text.trim()) {
                warnings.push(issue(`文件 ${file.path}`, '内容为空，已跳过'));
                continue;
            }
            const keyProblem = resourceKeyProblem(file.relative);
            if (keyProblem) {
                warnings.push(issue(`文件 ${file.path}`, `${keyProblem}，已跳过`));
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(resources, file.relative)) {
                warnings.push(issue(`文件 ${file.path}`, '资源路径重复，已跳过（保留先出现的一份）'));
                continue;
            }
            // 用 defineProperty 而不是 obj[key]：资源名可能是 __proto__ 这类特殊键
            Object.defineProperty(resources, file.relative, {
                value: file.text, enumerable: true, configurable: true, writable: true,
            });
            if (file.text.length > MAX_RESOURCE_CHARS) {
                warnings.push(issue(`文件 ${file.path}`, `超过 ${MAX_RESOURCE_CHARS} 字符：只读参考，插件可能截断（仍会完整保存）`));
            }
        }
        const count = Object.keys(resources).length;
        if (count > MAX_RESOURCES) {
            warnings.push(issue(`目录 ${top || '.'}`, `资源数量 ${count} 超过 ${MAX_RESOURCES} 个（仍会完整保存）`));
        }
        items.push({
            name: parsed.item.name,
            description: parsed.item.description,
            platform: parsed.item.platform,
            content: parsed.item.content,
            resources,
        });
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, items, warnings };
}

export const skillsSpec = {
    id: 'skills',
    navLabel: '技能',
    title: '技能',
    itemLabel: '技能',
    hint: '顺序 = system prompt「可用技能」的展示顺序',
    configKey: '技能列表',
    configGroup: '技能',
    collectionKey: 'skills',
    fileBase: 'aiplugin4-技能配置',
    storageKey: 'aiplugin4-config-skills-draft',
    accept: '.md,.markdown,.json',
    fileHint: '拖入 SKILL.md 或普通技能说明 .md；目录导入点「导入目录…」（SKILL.md + 同目录文本资源，建议 references/）',
    emptyText: '还没有技能，点「+ 添加技能」、拖入 SKILL.md，或点「导入目录…」',
    fields: [
        { key: 'name', label: '技能名', type: 'text', required: true, placeholder: '如：录卡', note: 'AI 通过 use_skill 按名称调用' },
        { key: 'description', label: '描述', type: 'text', placeholder: '一句话说明这个技能做什么' },
        { key: 'platform', label: '平台白名单', type: 'platform', placeholder: 'QQ, DISCORD（留空 = 所有平台）' },
        { key: 'content', label: '技能正文', type: 'textarea', rows: 16, required: true, placeholder: 'Markdown 正文' },
    ],
    options: [{
        key: 'includeDefaults',
        label: '自动补入出厂默认技能',
        type: 'checkbox',
        default: true,
        note: '关闭后可在列表中删除「录卡」等默认技能；生成的 JSON 会写 includeDefaults:false',
    }],
    defaults: DEFAULT_SKILLS,
    newItem: newSkill,
    normalizeItem(item) { return normalizeSkill(item); },
    validate: validateSkills,
    build: buildSkills,
    parseImport: parseSkillsImport,
    fromFile: skillFromFile,
    fromFiles: skillFromFiles,
    cardMeta(item) {
        const desc = item.description ? item.description : `${String(item.content || '').length} 字符`;
        const count = resourceCount(item);
        return `${platformLabel(item.platform)} · ${desc}${count > 0 ? ` · ${count} 个资源` : ''}`;
    },
    usage: [
        '点「+ 添加技能」或卡片上的「编辑」；也可以把 SKILL.md 文件拖进左侧。',
        '技能目录（SKILL.md + references/**）用「导入目录…」一次导入；其它文本文件会作为只读参考资源，插件不执行。',
        '点「复制全部」，粘到海豹 → JS插件 → 插件设置 → aiplugin4 →「技能」→「技能列表」。',
        '粘完下一条消息自动生效；也可用 .ai skill refresh 强制重解析。',
    ],
};
