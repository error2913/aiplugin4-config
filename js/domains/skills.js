// 技能分区：一份 JSON = { version: 1, skills: [{ name, description, platform, content }] }
// 对应插件侧「技能列表」（分组：技能）
import { DEFAULT_SKILLS } from './default-data.js';
import {
    baseName, issue, normalizeText, parseDocument, parsePlatform, platformLabel,
    readCollection, splitFrontmatter, validateName, validatePlatform, validateVersion,
} from './common.js';

export function newSkill() {
    return { name: '', description: '', platform: [], content: '', enabled: true };
}

export function normalizeSkill(item, problems, path) {
    const src = item && typeof item === 'object' ? item : {};
    const platform = problems
        ? validatePlatform(src.platform, `${path}.platform`, problems)
        : parsePlatform(src.platform);
    if (problems) {
        if (src.description !== undefined && src.description !== null && typeof src.description !== 'string') {
            problems.push(issue(`${path}.description`, 'description 必须是字符串'));
        }
        if (typeof src.content !== 'string') {
            problems.push(issue(`${path}.content`, 'content 必填（字符串）'));
        }
    }
    return {
        name: typeof src.name === 'string' ? src.name : '',
        description: typeof src.description === 'string' ? src.description : '',
        platform,
        content: typeof src.content === 'string' ? src.content : '',
        enabled: src.enabled !== false,
    };
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
    });
    for (const dup of duplicateNames(names)) {
        problems.push(issue('$.skills', `技能名重复：${dup}`));
    }
    return { problems, warnings };
}

export function buildSkills(items) {
    return {
        version: 1,
        skills: items.filter(item => item.enabled !== false).map(item => {
            const out = { name: item.name.trim() };
            if (item.description && item.description.trim()) out.description = item.description.trim();
            if (Array.isArray(item.platform) && item.platform.length > 0) out.platform = item.platform;
            out.content = item.content;
            return out;
        }),
    };
}

export function parseSkillsImport(text) {
    const parsed = parseDocument(text, 'skills', '技能配置');
    if (!parsed.ok) return { ok: false, issues: parsed.issues };
    const problems = [];
    validateVersion(parsed.value.version, problems);
    const list = readCollection(parsed.value, 'skills', problems);
    const items = list.map((item, i) => normalizeSkill(item, problems, `$.skills[${i}]`));
    const result = validateSkills(items);
    problems.push(...result.problems);
    if (problems.length > 0) return { ok: false, issues: problems };
    return { ok: true, items };
}

/** .md 文件 → 一条技能；SKILL.md 的 frontmatter 是跨 agent 标准格式，继续支持 */
export function skillFromFile(filename, text) {
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
        if (!name) warnings.push(issue(`文件 ${file}`, 'frontmatter 没有 name，已用文件名代替'));
    } else {
        warnings.push(issue(`文件 ${file}`, '没有 --- frontmatter，已把整份内容作为技能正文（建议补 name/description）'));
    }
    if (!name) name = baseName(filename);
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
    fileHint: '支持标准 SKILL.md（--- frontmatter + 正文）；一个文件一个技能',
    emptyText: '还没有技能，点「+ 添加技能」或把 SKILL.md 文件拖进来',
    fields: [
        { key: 'name', label: '技能名', type: 'text', required: true, placeholder: '如：录卡', note: 'AI 通过 use_skill 按名称调用' },
        { key: 'description', label: '描述', type: 'text', placeholder: '一句话说明这个技能做什么' },
        { key: 'platform', label: '平台白名单', type: 'platform', placeholder: 'QQ, DISCORD（留空 = 所有平台）' },
        { key: 'content', label: '技能正文', type: 'textarea', rows: 16, required: true, placeholder: 'Markdown 正文' },
    ],
    defaults: DEFAULT_SKILLS,
    newItem: newSkill,
    normalizeItem(item) { return normalizeSkill(item); },
    validate: validateSkills,
    build: buildSkills,
    parseImport: parseSkillsImport,
    fromFile: skillFromFile,
    cardMeta(item) {
        const desc = item.description ? item.description : `${String(item.content || '').length} 字符`;
        return `${platformLabel(item.platform)} · ${desc}`;
    },
    usage: [
        '点「+ 添加技能」或卡片上的「编辑」；也可以把 SKILL.md 文件拖进左侧。',
        '点「复制全部」，粘到海豹 → JS插件 → 插件设置 → aiplugin4 →「技能」→「技能列表」。',
        '粘完用 .ai skill refresh 立即生效（或重载 JS）。',
    ],
};
