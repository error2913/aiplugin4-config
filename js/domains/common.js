// 角色 / 技能 / MCP / 知识库四个分区的共用纯逻辑。
//
// 与插件侧 src/config/domain/ 的解析规则一一对应（schema 版本 1），
// 由 aiplugin4 仓库的跨仓库联测钉住漂移。本文件不碰 DOM，node 测试可直接 import。

/** 配置格式版本；与插件侧一致 */
export const DOMAIN_VERSION = 1;

/** 各分区统一的问题对象：{ path: '$.skills[0].name', msg: '...' } */
export function issue(path, msg) {
    return { path, msg };
}

/** 去 UTF-8 BOM（Windows 导出的文件常见） */
export function stripBom(text) {
    return String(text ?? '').replace(/^\uFEFF/, '');
}

/** 统一换行：CRLF / CR → LF */
export function normalizeText(text) {
    return stripBom(text).replace(/\r\n?/g, '\n');
}

export function unquote(value) {
    return String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

export function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 解析 platform 字段：字符串或字符串数组。
 * 空值 / 空数组 / 缺省 → []（= 所有平台）。
 */
export function parsePlatform(value) {
    if (Array.isArray(value)) {
        return value.map(x => String(x ?? '').trim()).filter(Boolean);
    }
    let v = String(value ?? '').trim();
    if (!v) return [];
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
    return v.split(',').map(unquote).filter(Boolean);
}

/** 把 platform 数组压成编辑框里的文本（逗号分隔） */
export function formatPlatform(list) {
    return Array.isArray(list) ? list.join(', ') : '';
}

/** 平台显示文本（卡片元信息用） */
export function platformLabel(list) {
    return list && list.length > 0 ? list.join(' / ') : '所有平台';
}

/**
 * YAML-ish frontmatter 解析。只用于**技能文件**（标准 SKILL.md）：
 * 这是 Claude / Codex / Cursor 等 agent 通用的技能文件格式。
 * 角色 / 知识库 / MCP 的文件导入不解析 frontmatter。
 */
export function parseFrontmatter(raw) {
    const meta = {};
    for (const line of String(raw ?? '').split('\n')) {
        const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (!value) continue;
        if (key === 'name') meta.name = unquote(value);
        else if (key === 'description') meta.description = unquote(value);
        else if (key === 'platform' || key === 'platforms') meta.platform = parsePlatform(value);
    }
    return meta;
}

/** 拆分 frontmatter；没有 frontmatter 返回 null */
export function splitFrontmatter(text) {
    const normalized = normalizeText(text);
    const m = normalized.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?([\s\S]*)$/);
    if (!m) return null;
    return { meta: parseFrontmatter(m[1]), body: m[2].trim() };
}

/** 第一条 # 一级标题 */
export function firstHeading(markdown) {
    const m = normalizeText(markdown).match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : '';
}

/** 标题后的第一段（最多 200 字），与插件知识库描述兜底一致 */
export function firstParagraph(markdown) {
    const lines = normalizeText(markdown).split('\n');
    let started = false;
    const buffer = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!started) {
            if (/^#\s+/.test(trimmed)) started = true;
            continue;
        }
        if (/^#{1,6}\s+/.test(trimmed)) break;
        if (!trimmed) {
            if (buffer.length > 0) break;
            continue;
        }
        buffer.push(trimmed);
        if (buffer.join(' ').length >= 200) break;
    }
    return buffer.join(' ').slice(0, 200);
}

/** 去掉路径与扩展名：C:\a\SKILL.md → SKILL */
export function baseName(filename) {
    return String(filename ?? '')
        .replace(/^.*[\\/]/, '')
        .replace(/\.[^.]+$/, '')
        .trim();
}

/** 文件名（含扩展名），只用于展示 */
export function fileName(filename) {
    return String(filename ?? '').replace(/^.*[\\/]/, '');
}

/** 解析 JSON，兼容尾逗号（与插件 utils/json.ts 同一策略） */
export function parseJsonWithTrailingCommas(text) {
    const raw = String(text ?? '');
    try {
        return JSON.parse(raw);
    } catch (firstError) {
        const normalized = removeTrailingCommas(raw);
        if (normalized === raw) throw firstError;
        return JSON.parse(normalized);
    }
}

function removeTrailingCommas(text) {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            result += char;
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            result += char;
            continue;
        }
        if (char === ',') {
            let next = i + 1;
            while (next < text.length && /\s/.test(text[next])) next++;
            if (text[next] === '}' || text[next] === ']') continue;
        }
        result += char;
    }
    return result;
}

/** 名称唯一性检查：重复时返回重复的名称列表 */
export function duplicateNames(names) {
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

/** 校验 platform 字段并归一；非法时写入 problems 并返回 [] */
export function validatePlatform(value, path, problems) {
    if (value === undefined || value === null) return [];
    if (typeof value === 'string') {
        const list = parsePlatform(value);
        if (list.length === 0 && value.trim() !== '' && value.trim() !== '[]') {
            // 例如 "QQ,,DISCORD" 这类其实仍能解析；只有完全空值才落到这里
        }
        return list;
    }
    if (!Array.isArray(value)) {
        problems.push(issue(path, 'platform 必须是字符串或字符串数组'));
        return [];
    }
    const out = [];
    for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string') {
            problems.push(issue(`${path}[${i}]`, '平台名必须是字符串'));
            continue;
        }
        const item = unquote(value[i]);
        if (item) out.push(item);
    }
    return out;
}

/** 统一校验一个条目的 name 字段 */
export function validateName(value, path, problems) {
    if (typeof value !== 'string' || !value.trim()) {
        problems.push(issue(path, 'name 必填（字符串）'));
        return '';
    }
    return value.trim();
}

/** 统一校验一个条目的 content/prompt 字段 */
export function validateContent(value, path, problems, label = 'content') {
    if (typeof value !== 'string' || !value.trim()) {
        problems.push(issue(path, `${label} 必填（字符串）`));
        return '';
    }
    return value;
}

/** 可选字符串字段：undefined/null 视为缺省；非字符串报错 */
export function validateOptionalString(value, path, problems, label) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
        problems.push(issue(path, `${label} 必须是字符串`));
        return '';
    }
    return value;
}

/** 深拷贝（只含 JSON 可表达的数据） */
export function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

/** 让 items 带上 UI 侧 uid；返回新数组 */
export function withUids(items, nextUid) {
    return (Array.isArray(items) ? items : []).map(item => ({ ...item, _uid: nextUid() }));
}

/** 从原对象里挑出指定键（按键顺序生成新对象） */
export function pick(obj, keys) {
    const out = {};
    for (const key of keys) {
        if (obj[key] !== undefined) out[key] = obj[key];
    }
    return out;
}

/** 统一输出：紧凑或缩进 */
export function stringifyConfig(config, pretty) {
    return pretty ? JSON.stringify(config, null, 2) : JSON.stringify(config);
}

/**
 * 解析一份“整份 JSON”导入内容：支持规范对象与裸数组。
 * @returns {{ok:boolean, value?:any, issues:Array}}
 */
export function parseDocument(text, collectionKey, label) {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, issues: [issue('$', '内容为空')] };
    let value;
    try {
        value = parseJsonWithTrailingCommas(raw);
    } catch (e) {
        return { ok: false, issues: [issue('$', `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)] };
    }
    if (Array.isArray(value)) return { ok: true, value: { version: DOMAIN_VERSION, [collectionKey]: value } };
    if (!isPlainObject(value)) return { ok: false, issues: [issue('$', `${label}必须是 JSON 对象或数组`)] };
    return { ok: true, value };
}

/** 校验顶层 version（缺省按 1 兼容，便于手写/旧工具导入） */
export function validateVersion(value, problems) {
    if (value === undefined || value === null) return DOMAIN_VERSION;
    if (value !== DOMAIN_VERSION) {
        problems.push(issue('$.version', `版本不支持：${JSON.stringify(value)}（当前只支持 ${DOMAIN_VERSION}）`));
    }
    return value;
}

/** 把顶层集合取出并校验为数组 */
export function readCollection(value, collectionKey, problems) {
    const list = value[collectionKey];
    if (!Array.isArray(list)) {
        problems.push(issue(`$.${collectionKey}`, `${collectionKey} 必须是数组`));
        return [];
    }
    return list;
}

/** 解析错误转成一行文本（导入面板用） */
export function formatIssues(issues, limit = 8) {
    const list = (Array.isArray(issues) ? issues : []).slice(0, limit)
        .map(i => `${i.path} ${i.msg}`);
    if (issues.length > limit) list.push(`…还有 ${issues.length - limit} 处`);
    return list.join('\n');
}

/** 文件导入兜底：拒绝明显的二进制内容（PDF/zip/图片等） */
export function looksBinary(text) {
    const sample = String(text ?? '').slice(0, 1000);
    if (sample.includes('\u0000')) return true;
    // 允许中文与普通 Markdown；只拦大量不可打印字符
    let weird = 0;
    for (let i = 0; i < sample.length; i++) {
        const code = sample.charCodeAt(i);
        if (code < 9 || (code > 13 && code < 32)) weird++;
    }
    return weird > sample.length * 0.05;
}
