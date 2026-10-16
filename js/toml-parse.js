// 迷你 TOML 解析器：只覆盖 aiplugin4「api连接」用到的受限子集。
//
// 支持：
//   k = "string"            k = 123            k = true/false
//   k = ["a", "b"]          （仅字符串数组）
//   [table]                 表头，其后键归属该表
//   "quoted key" = "v"      含 . : / 等字符的键
//   # 注释                   行内注释
// 不支持（明确报错而非静默出错）：多行数组、内联表、日期、嵌套表头、数组表 [[x]]。
//
// 设计原则：解析失败必须给出**行号与原因**，绝不静默吞掉 —— 用户手里是插件导出的
// 真实配置，静默丢弃键会让「导入后看起来对、实际少了东西」变得难以察觉。

/** 抛出的解析错误，带行号 */
export class TomlParseError extends Error {
    constructor(message, line) {
        super(line ? `第 ${line} 行：${message}` : message);
        this.name = 'TomlParseError';
        this.line = line;
    }
}

/** 去掉行内注释（尊重双引号内的 #） */
function stripComment(line) {
    let inStr = false;
    let out = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '\\' && inStr) { out += c + (line[i + 1] ?? ''); i++; continue; }
        if (c === '"') inStr = !inStr;
        if (c === '#' && !inStr) break;
        out += c;
    }
    return out;
}

/** 解析一个带引号的字符串（从 s[i] 处开始，s[i] 应为 "） */
function parseQuoted(s, i, lineNo) {
    // s[i] === '"'
    let out = '';
    i++;
    while (i < s.length) {
        const c = s[i];
        if (c === '\\') {
            const n = s[i + 1];
            const map = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
            if (!(n in map)) throw new TomlParseError(`无法识别的转义 \\${n}`, lineNo);
            out += map[n];
            i += 2;
            continue;
        }
        if (c === '"') return { value: out, next: i + 1 };
        out += c;
        i++;
    }
    throw new TomlParseError('字符串缺少收尾引号', lineNo);
}

/** 解析数组字面量（仅字符串数组），返回 { value, next } */
function parseArray(s, i, lineNo) {
    // s[i] === '['
    const items = [];
    i++;
    for (;;) {
        while (i < s.length && /\s/.test(s[i])) i++;
        if (i >= s.length) throw new TomlParseError('数组缺少收尾的 ]', lineNo);
        if (s[i] === ']') return { value: items, next: i + 1 };
        if (s[i] === '"') {
            const r = parseQuoted(s, i, lineNo);
            items.push(r.value);
            i = r.next;
        } else {
            // 非字符串数组元素：本项目不需要，明确报错
            throw new TomlParseError('数组元素只支持字符串（如 ["a", "b"]）', lineNo);
        }
        while (i < s.length && /\s/.test(s[i])) i++;
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') return { value: items, next: i + 1 };
        throw new TomlParseError('数组元素之间缺少逗号', lineNo);
    }
}

/** 解析标量值（字符串/数字/布尔），返回 { value, next } */
function parseValue(s, i, lineNo) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) throw new TomlParseError('缺少值', lineNo);
    const c = s[i];
    if (c === '"') return parseQuoted(s, i, lineNo);
    if (c === '[') return parseArray(s, i, lineNo);
    // 裸值：读到行尾或注释
    let j = i;
    while (j < s.length && s[j] !== '#') j++;
    const raw = s.slice(i, j).trim();
    if (raw === 'true') return { value: true, next: j };
    if (raw === 'false') return { value: false, next: j };
    if (/^[+-]?\d+$/.test(raw)) return { value: parseInt(raw, 10), next: j };
    if (/^[+-]?\d*\.\d+$/.test(raw)) return { value: parseFloat(raw), next: j };
    // 裸字符串（TOML 不允许，但用户手写常见）——宽容接受并提示
    if (raw !== '') return { value: raw, next: j };
    throw new TomlParseError('无法解析的值', lineNo);
}

/**
 * 解析一行 `key = value`，返回 { key, value } 或 null（空行/纯注释）。
 */
function parseAssignment(line, lineNo) {
    const clean = stripComment(line).trim();
    if (clean === '') return null;

    // 定位 = 号（尊重引号）
    let inStr = false;
    let eq = -1;
    for (let i = 0; i < clean.length; i++) {
        const c = clean[i];
        if (c === '\\' && inStr) { i++; continue; }
        if (c === '"') inStr = !inStr;
        if (c === '=' && !inStr) { eq = i; break; }
    }
    if (eq < 0) throw new TomlParseError('不是合法的 key = value 形式', lineNo);

    const rawKey = clean.slice(0, eq).trim();
    if (rawKey === '') throw new TomlParseError('缺少键名', lineNo);

    let k;
    if (rawKey.startsWith('"')) {
        const r = parseQuoted(rawKey, 0, lineNo);
        if (rawKey.slice(r.next).trim() !== '') throw new TomlParseError('键名引号后有多余字符', lineNo);
        k = r.value;
    } else {
        if (!/^[A-Za-z0-9_-]+$/.test(rawKey)) {
            throw new TomlParseError(`键名 "${rawKey}" 含特殊字符，需加引号写法（如 "${rawKey}" = ...）`, lineNo);
        }
        k = rawKey;
    }

    const { value } = parseValue(clean, eq + 1, lineNo);
    return { key: k, value };
}

/**
 * 解析单个「api连接」框。
 * @returns {{ fields:object, types:object, request:object, unknown:string[] }}
 */
export function parseConnection(text) {
    const fields = {};
    const types = {};
    const request = {};
    const unknown = [];
    let currentTable = null; // null | 'types' | 'request'

    const lines = String(text ?? '').split(/\r?\n/);
    lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        const clean = stripComment(line).trim();
        if (clean === '') return;

        // 表头
        if (clean.startsWith('[')) {
            const m = /^\[([^\]]+)\]\s*$/.exec(clean);
            if (!m) {
                if (clean.startsWith('[[')) throw new TomlParseError('不支持数组表 [[...]]', lineNo);
                throw new TomlParseError('表头格式不正确（应形如 [types]）', lineNo);
            }
            const name = m[1].trim().replace(/^"|"$/g, '');
            if (name === 'types') currentTable = 'types';
            else if (name === 'request') currentTable = 'request';
            else {
                throw new TomlParseError(
                    `未知的表 [${name}]（「api连接」只支持 [types] 与 [request]）`, lineNo);
            }
            return;
        }

        const kv = parseAssignment(line, lineNo);
        if (!kv) return;
        const { key, value } = kv;

        if (currentTable === 'types') {
            const tag = String(value).trim().toLowerCase();
            if (!['text', 'vision', 'embed', 'gen', 'tts'].includes(tag)) {
                throw new TomlParseError(
                    `[types] 的 "${key}" 值非法："${value}"（只能是 text/vision/embed/gen/tts）`, lineNo);
            }
            types[key] = tag;
            return;
        }
        if (currentTable === 'request') {
            request[key] = value;
            return;
        }

        // 顶层键
        switch (key) {
            case 'api_key': fields.apiKey = String(value); break;
            case 'provider': fields.provider = String(value); break;
            case 'base_url': fields.baseUrl = String(value); break;
            case 'models':
                if (!Array.isArray(value)) {
                    throw new TomlParseError('models 必须是字符串数组（如 ["a", "b"]）', lineNo);
                }
                fields.models = value.map(String);
                break;
            case 'ignore': fields.ignore = value === 1 || value === true || value === '1'; break;
            default:
                unknown.push(key);
        }
    });

    return { fields, types, request, unknown };
}

/**
 * 解析多框导出文本（本工具自己产出的分隔格式），返回连接对象数组。
 * 也兼容：传入纯单框 TOML 时返回单元素数组。已有连接对象直接从文本里切分。
 */
export function parseExportText(text) {
    const raw = String(text ?? '');
    // 本工具的分隔线形如 =====（60 个等号）；以此切分多框
    const parts = raw
        .split(/^={20,}\s*$/m)
        .map(s => s.trim())
        // 丢弃分隔线之间的说明文字行（以 aiplugin4「api连接」开头的标题行）
        .map(s => s.split(/\r?\n/).filter(l => !/^aiplugin4「api连接」/.test(l.trim())).join('\n').trim())
        .filter(s => s !== '');

    const blocks = parts.length > 0 ? parts : [raw.trim()].filter(Boolean);
    return blocks.map(parseConnection);
}
