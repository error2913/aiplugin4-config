// 知识库分区：一份 JSON = { version: 1, libraries: [{ name, description, platform, content }] }
// 对应插件侧「知识库（JSON）」（分组：知识库）
import { DEFAULT_KB } from './default-data.js';
import {
    baseName, firstHeading, firstParagraph, issue, normalizeText, parseDocument,
    parsePlatform, platformLabel, readCollection, validateName,
    validatePlatform, validateVersion,
} from './common.js';

export function newLibrary() {
    return { name: '', description: '', platform: [], content: '', enabled: true };
}

export function normalizeLibrary(item, problems, path) {
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

export function validateLibraries(items) {
    const problems = [];
    const warnings = [];
    const names = [];
    items.forEach((item, i) => {
        if (item.enabled === false) return;
        const path = `$.libraries[${i}]`;
        names.push(validateName(item.name, `${path}.name`, problems));
        if (typeof item.content !== 'string' || !item.content.trim()) {
            problems.push(issue(`${path}.content`, 'content 必填（Markdown 正文）'));
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
    });
    for (const dup of duplicateNames(names)) {
        problems.push(issue('$.libraries', `知识库名重复：${dup}`));
    }
    return { problems, warnings };
}

export function buildKb(items) {
    return {
        version: 1,
        libraries: items.filter(item => item.enabled !== false).map(item => {
            const out = { name: item.name.trim() };
            if (item.description && item.description.trim()) out.description = item.description.trim();
            if (Array.isArray(item.platform) && item.platform.length > 0) out.platform = item.platform;
            out.content = item.content;
            return out;
        }),
    };
}

export function parseKbImport(text) {
    const parsed = parseDocument(text, 'libraries', '知识库配置');
    if (!parsed.ok) return { ok: false, issues: parsed.issues };
    const problems = [];
    validateVersion(parsed.value.version, problems);
    const list = readCollection(parsed.value, 'libraries', problems);
    const items = list.map((item, i) => normalizeLibrary(item, problems, `$.libraries[${i}]`));
    const result = validateLibraries(items);
    problems.push(...result.problems);
    if (problems.length > 0) return { ok: false, issues: problems };
    return { ok: true, items };
}

/** .md / .txt 文件 → 一个库：库名取首个 # 标题，其次文件名；描述取正文首段 */
export function kbFromFile(filename, text) {
    const raw = normalizeText(text).trim();
    const file = String(filename ?? '').split(/[\\/]/).pop() || '(未命名)';
    if (!raw) return { ok: false, issues: [{ path: `文件 ${file}`, msg: '文件为空' }] };
    const name = (firstHeading(raw) || baseName(filename) || '').trim();
    if (!name) return { ok: false, issues: [{ path: `文件 ${file}`, msg: '无法确定库名（# 标题或文件名）' }] };
    return {
        ok: true,
        item: { name, description: firstParagraph(raw), platform: [], content: raw },
    };
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

export const kbSpec = {
    id: 'kb',
    navLabel: '知识库',
    title: '知识库',
    itemLabel: '知识库',
    hint: '顺序 = system prompt「知识库」段的展示顺序',
    configKey: '知识库（JSON）',
    configGroup: '知识库',
    collectionKey: 'libraries',
    fileBase: 'aiplugin4-知识库',
    storageKey: 'aiplugin4-config-kb-draft',
    accept: '.md,.markdown,.txt',
    fileHint: '支持 .md / .txt；一个文件一个库（frontmatter / # 标题 / 文件名确定库名）',
    emptyText: '还没有知识库，点「+ 添加知识库」或把 Markdown 文件拖进来',
    fields: [
        { key: 'name', label: '库名', type: 'text', required: true, placeholder: '如：核心指令' },
        { key: 'description', label: '描述', type: 'text', placeholder: '一句话说明这个库讲什么', note: '留空时插件会用正文首段兜底' },
        { key: 'platform', label: '平台白名单', type: 'platform', placeholder: 'QQ, DISCORD（留空 = 所有平台）' },
        { key: 'content', label: 'Markdown 正文', type: 'textarea', rows: 18, required: true, placeholder: '# 库标题\n\n正文……', note: '# 一级标题 = 条目，##/### = 条目下的小节' },
    ],
    defaults: DEFAULT_KB,
    newItem: newLibrary,
    normalizeItem(item) { return normalizeLibrary(item); },
    validate: validateLibraries,
    build: buildKb,
    parseImport: parseKbImport,
    fromFile: kbFromFile,
    cardMeta(item) {
        const desc = item.description ? item.description : `${String(item.content || '').length} 字符`;
        return `${platformLabel(item.platform)} · ${desc}`;
    },
    usage: [
        '点「+ 添加知识库」或卡片上的「编辑」；也可以把 .md / .txt 文件拖进左侧。',
        '点「复制全部」，粘到海豹 → JS插件 → 插件设置 → aiplugin4 →「知识库」→「知识库（JSON）」。',
        '粘完用 .ai kb refresh 立即生效；知识库为只读数据，AI 只能检索不能修改。',
    ],
};
