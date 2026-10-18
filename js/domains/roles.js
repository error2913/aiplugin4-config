// 角色设定分区：一份 JSON = { version: 1, roles: [{ name, prompt }] }
// 对应插件侧「角色设定」（分组：角色设定）
import { DEFAULT_ROLES } from './default-data.js';
import {
    baseName, issue, normalizeText, parseDocument, readCollection, validateName, validateVersion,
} from './common.js';

export function newRole() {
    return { name: '', prompt: '', enabled: true };
}

export function normalizeRole(item) {
    const src = item && typeof item === 'object' ? item : {};
    return {
        name: typeof src.name === 'string' ? src.name : '',
        prompt: typeof src.prompt === 'string' ? src.prompt : '',
        enabled: src.enabled !== false,
    };
}

export function validateRoles(items) {
    const problems = [];
    const warnings = [];
    const names = [];
    items.forEach((item, i) => {
        if (item.enabled === false) return;
        const path = `$.roles[${i}]`;
        const name = validateName(item.name, `${path}.name`, problems);
        names.push(name);
        if (name.length > 20) {
            warnings.push(issue(`${path}.name`, `角色名超过 20 字符，插件会截断为「${name.slice(0, 20)}」`));
        }
        if (typeof item.prompt !== 'string' || !item.prompt.trim()) {
            problems.push(issue(`${path}.prompt`, 'prompt 必填（角色设定内容）'));
        }
    });
    for (const dup of duplicateNames(names)) {
        problems.push(issue('$.roles', `角色名重复：${dup}`));
    }
    return { problems, warnings };
}

export function buildRoles(items) {
    return {
        version: 1,
        roles: items.filter(item => item.enabled !== false).map(item => ({
            name: item.name.trim(),
            prompt: item.prompt,
        })),
    };
}

/** 解析整份 JSON（支持裸数组） */
export function parseRolesImport(text) {
    const parsed = parseDocument(text, 'roles', '角色设定配置');
    if (!parsed.ok) return { ok: false, issues: parsed.issues };
    const problems = [];
    validateVersion(parsed.value.version, problems);
    const list = readCollection(parsed.value, 'roles', problems);
    const items = list.map(normalizeRole);
    const result = validateRoles(items);
    problems.push(...result.problems);
    if (problems.length > 0) return { ok: false, issues: problems };
    return { ok: true, items };
}

/** 从 .md / .txt 文件转一个角色：角色名取文件名，正文即设定（不解析 frontmatter） */
export function roleFromFile(filename, text) {
    const raw = normalizeText(text).trim();
    const file = String(filename ?? '').split(/[\\/]/).pop() || '(未命名)';
    if (!raw) return { ok: false, issues: [{ path: `文件 ${file}`, msg: '文件为空' }] };
    const name = (baseName(filename) || '').trim().slice(0, 20);
    if (!name) return { ok: false, issues: [{ path: `文件 ${file}`, msg: '无法从文件名确定角色名' }] };
    return { ok: true, item: { name, prompt: raw } };
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

export const rolesSpec = {
    id: 'roles',
    navLabel: '角色设定',
    title: '角色',
    itemLabel: '角色',
    hint: '顺序 = 插件里的角色序号；第一行名称会被 .ai role 使用',
    configKey: '角色设定',
    configGroup: '角色设定',
    collectionKey: 'roles',
    fileBase: 'aiplugin4-角色设定',
    storageKey: 'aiplugin4-config-roles-draft',
    accept: '.md,.markdown,.txt',
    fileHint: '支持 .md / .txt；一个文件一个角色（文件名作为角色名，正文作为设定）',
    emptyText: '还没有角色，点「+ 添加角色」或把 Markdown / 文本文件拖进来',
    fields: [
        { key: 'name', label: '角色名', type: 'text', required: true, maxLength: 20, placeholder: '如：测试机器人', note: '超过 20 字符时插件会截断' },
        { key: 'prompt', label: '设定内容', type: 'textarea', rows: 16, required: true, placeholder: '你是一个……', note: '作为 system prompt 中的角色设定注入' },
    ],
    defaults: DEFAULT_ROLES,
    newItem: newRole,
    normalizeItem: normalizeRole,
    validate: validateRoles,
    build: buildRoles,
    parseImport: parseRolesImport,
    fromFile: roleFromFile,
    cardMeta(item) {
        return `${String(item.prompt || '').length} 字符`;
    },
    usage: [
        '点「+ 添加角色」或卡片上的「编辑」写设定；也可以把 .md / .txt 文件拖进左侧。',
        '点「复制全部」，粘到海豹 → JS插件 → 插件设置 → aiplugin4 →「角色设定」→「角色设定」。',
        '重载 JS 生效；.ai role 可切换角色。',
    ],
};
