// MCP 分区：**标准 MCP 配置 JSON**：
//   { "mcpServers": { "<服务器名>": { "type": "http", "url": "...", "headers": {…} } } }
// 对应插件侧「MCP服务器」（分组：MCP）。
//
// 与 Claude Desktop / Cursor 的 .mcp.json 顶层结构一致；aiplugin4 额外支持扩展字段：
//   platform: [QQ]        —— 平台白名单（可选）
//   capability: "image-host" —— 能力声明（可选；插件据此注册图床适配器，方案 §9.4）
//   imageRefs: true       —— 旧版图片引用生产者开关（兼容一版，语义与 capability 不同）
// 生成器的「启用」开关不写进 JSON：关闭 = 该服务器直接不出现在 mcpServers 里。
// 只支持 Streamable HTTP：stdio（command）与 SSE 会被插件跳过，这里导入时直接警告并跳过。
import { DEFAULT_MCP } from './default-data.js';
import {
    clone, duplicateNames, isPlainObject, issue, parseJsonWithTrailingCommas,
    parsePlatform, platformLabel, validateName, validatePlatform,
} from './common.js';

const TYPES = ['http', 'streamable-http'];

export function newServer() {
    return {
        name: '', platform: [], enabled: true, type: 'http', url: '', token: '', headers: {},
        // 能力声明（扩展字段）：'' = 不填，目前只认 image-host
        capability: '',
    };
}

/**
 * 归一一个服务器条目。
 *
 * capability（插件方案 §9.4）：标准 mcpServers 的扩展字段，目前只认 'image-host'。
 * 非法值按**警告后忽略**处理（与插件 parse.ts:283-292 同口径）—— 旧数据/手写 JSON
 * 里出现未来能力名时不该整份导入失败，只是那个字段不生效。
 *
 * @param {object} item 原始条目
 * @param {Array} [problems] 阻断问题收集器（导入/校验用）
 * @param {string} [path] 报错路径
 * @param {Array} [warnings] 提示收集器（未知 capability 走这里）
 */
export function normalizeServer(item, problems, path, warnings) {
    const src = item && typeof item === 'object' ? item : {};
    const p = path || '$';
    const platform = problems
        ? validatePlatform(src.platform, `${p}.platform`, problems)
        : parsePlatform(src.platform);

    // enabled 只是生成器的 UI 开关，不写进 JSON；这里从草稿/旧配置里恢复状态
    const enabled = src.enabled !== false;

    let type = typeof src.type === 'string' && src.type.trim() ? src.type.trim().toLowerCase() : 'http';
    if (!TYPES.includes(type)) {
        if (problems) problems.push(issue(`${p}.type`, `不支持的传输类型 ${JSON.stringify(src.type)}（仅支持 ${TYPES.join(' / ')}）`));
        type = String(src.type || 'http');
    }

    let headers = {};
    if (src.headers !== undefined && src.headers !== null) {
        if (!isPlainObject(src.headers)) {
            if (problems) problems.push(issue(`${p}.headers`, 'headers 必须是对象（键值都是字符串）'));
        } else {
            for (const [k, v] of Object.entries(src.headers)) {
                if (typeof v !== 'string') {
                    if (problems) problems.push(issue(`${p}.headers.${k}`, 'header 值必须是字符串'));
                } else {
                    headers[k] = v;
                }
            }
        }
    }

    if (problems) {
        if (typeof src.token !== 'string' && src.token !== undefined && src.token !== null) {
            problems.push(issue(`${p}.token`, 'token 必须是字符串'));
        }
        if (typeof src.url !== 'string') {
            problems.push(issue(`${p}.url`, 'url 必填（字符串）'));
        }
    }

    // capability：能力声明扩展字段（当前只认 image-host；非法值 WARN 后忽略，方案 §9.4）
    let capability = '';
    if (src.capability !== undefined && src.capability !== null) {
        if (typeof src.capability === 'string' && src.capability.trim() === 'image-host') {
            capability = 'image-host';
        } else {
            const msg = `capability 仅支持 "image-host"，已忽略：${JSON.stringify(src.capability)}`;
            if (warnings) warnings.push(issue(`${p}.capability`, msg));
            else if (problems) problems.push(issue(`${p}.capability`, msg));
        }
    }

    return {
        name: typeof src.name === 'string' ? src.name : '',
        platform,
        enabled,
        type,
        url: typeof src.url === 'string' ? src.url.trim() : '',
        token: typeof src.token === 'string' ? src.token : '',
        headers,
        // 能力声明（扩展字段）：插件据此注册图床适配器（image_search/keep/unkeep/tag）
        ...(capability ? { capability } : {}),
        // 图片引用生产者扩展字段（旧版 imageRefs）：true 时插件会把结果里的 [img:<sha>] 规范化。
        // 与 capability **语义不同**（一个管工具结果图片引用、一个管适配器注册），不能互替。
        ...(src.imageRefs === true ? { imageRefs: true } : {}),
    };
}

/** 服务器在标准 JSON 里的路径：$.mcpServers.<name>（名称用于报错定位） */
function serverPath(i, item) {
    const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : `[${i}]`;
    return `$.mcpServers.${name}`;
}

export function validateServers(items) {
    const problems = [];
    const warnings = [];
    const names = [];
    items.forEach((item, i) => {
        if (item.enabled === false) return;
        const path = serverPath(i, item);
        names.push(validateName(item.name, `${path}（键名）`, problems));
        if (!item.url) {
            problems.push(issue(`${path}.url`, 'url 必填'));
        } else if (!/^https?:\/\/\S+$/i.test(item.url)) {
            problems.push(issue(`${path}.url`, 'url 必须是 http:// 或 https:// 地址'));
        }
        if (!TYPES.includes(item.type)) {
            problems.push(issue(`${path}.type`, `type 只支持 ${TYPES.join(' / ')}`));
        }
        if (!isPlainObject(item.headers)) {
            problems.push(issue(`${path}.headers`, 'headers 必须是对象'));
        }
        // 防御：非 normalize 路径进来的条目也拦住未知 capability（导出时会忽略）
        if (item.capability !== undefined && item.capability !== '' && item.capability !== 'image-host') {
            warnings.push(issue(`${path}.capability`, `capability 仅支持 "image-host"，导出时会忽略：${JSON.stringify(item.capability)}`));
        }
        if (item.token && item.headers && item.headers.Authorization) {
            warnings.push(issue(path, '同时填了 token 与 Authorization header：插件会优先使用 headers 里的 Authorization'));
        }
    });
    for (const dup of duplicateNames(names)) {
        problems.push(issue('$.mcpServers', `服务器名重复：${dup}`));
    }
    return { problems, warnings };
}

/**
 * 内部条目 → 标准 MCP JSON。
 * token 是 UI 的简写：导出时合并成 `Authorization: Bearer …`，不输出非标准的 token 字段。
 */
export function buildMcp(items) {
    const mcpServers = {};
    for (const item of items) {
        if (item.enabled === false) continue;
        const headers = { ...(item.headers || {}) };
        if (item.token && !headers.Authorization) headers.Authorization = `Bearer ${item.token}`;
        const entry = { type: item.type || 'http', url: item.url };
        if (Object.keys(headers).length > 0) entry.headers = headers;
        if (item.platform && item.platform.length > 0) entry.platform = item.platform;
        // capability 是标准 mcpServers 的扩展字段（插件解析：合法则保留，非法则 WARN 忽略）
        if (item.capability === 'image-host') entry.capability = 'image-host';
        // 旧字段按原样往返（兼容一版）：语义与 capability 不同，不互替
        if (item.imageRefs === true) entry.imageRefs = true;
        mcpServers[item.name.trim()] = entry;
    }
    return { mcpServers };
}

/** 一个 server 条目（对象）→ 内部 item；stdio/SSE 返回 null */
function convertServerEntry(name, cfg, path, warnings, problems) {
    if (!isPlainObject(cfg)) {
        problems.push(issue(path, '服务器条目必须是对象（标准 mcpServers 的值）'));
        return null;
    }
    if (cfg.command || String(cfg.type || '').toLowerCase() === 'stdio') {
        warnings.push(issue(path, `服务器 ${name} 使用 stdio（command），海豹无法拉起子进程，已跳过`));
        return null;
    }
    const type = String(cfg.type || 'http').toLowerCase();
    if (type === 'sse') {
        warnings.push(issue(path, `服务器 ${name} 使用 SSE 传输，插件只支持 Streamable HTTP，已跳过`));
        return null;
    }
    if (cfg.env !== undefined) {
        warnings.push(issue(path, `服务器 ${name} 的 env 字段不会被插件使用，已忽略`));
    }
    if (cfg.args !== undefined) {
        warnings.push(issue(path, `服务器 ${name} 的 args 字段不会被插件使用，已忽略`));
    }
    return normalizeServer({ ...cfg, name }, problems, path, warnings);
}

/** 解析标准 MCP JSON：顶层必须是 { mcpServers: { <name>: {...} } } */
export function parseMcpDocument(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, issues: [issue('$', '内容为空')] };
    let value;
    try {
        value = parseJsonWithTrailingCommas(raw);
    } catch (e) {
        return { ok: false, issues: [issue('$', `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)] };
    }
    if (!isPlainObject(value) || !isPlainObject(value.mcpServers)) {
        return { ok: false, issues: [issue('$.mcpServers', '标准 MCP 配置需要顶层 mcpServers 对象（{"mcpServers":{"服务器名":{…}}}）')] };
    }

    const warnings = [];
    const problems = [];
    const items = [];
    for (const [name, cfg] of Object.entries(value.mcpServers)) {
        const path = `$.mcpServers.${name}`;
        const item = convertServerEntry(name, cfg, path, warnings, problems);
        if (item) items.push(item);
    }
    if (items.length === 0) {
        return { ok: false, issues: [...problems, ...warnings, issue('$.mcpServers', '没有可用的服务器（stdio / SSE / 非法条目都已跳过）')] };
    }
    const result = validateServers(items);
    if (result.problems.length > 0 || problems.length > 0) {
        return { ok: false, issues: [...problems, ...warnings, ...result.problems] };
    }
    return { ok: true, items, warnings: [...warnings, ...result.warnings] };
}

export function parseMcpImport(text) {
    const result = parseMcpDocument(text);
    if (!result.ok) return result;
    return { ok: true, items: result.items, warnings: result.warnings };
}

/** .json 文件 → 一个或多个服务器（同样要求标准 mcpServers 结构） */
export function mcpFromFile(_filename, text) {
    return parseMcpDocument(text);
}

/** 导出时遮蔽 Authorization 等敏感头 */
export function maskMcp(config) {
    const copy = clone(config);
    for (const server of Object.values(copy.mcpServers || {})) {
        if (!server || typeof server !== 'object') continue;
        if (server.headers && typeof server.headers === 'object') {
            for (const key of Object.keys(server.headers)) {
                if (/authorization|token|key|secret|cookie/i.test(key)) {
                    server.headers[key] = 'xxxx';
                }
            }
        }
    }
    return copy;
}

export const mcpSpec = {
    id: 'mcp',
    navLabel: 'MCP',
    title: 'MCP 服务器',
    itemLabel: '服务器',
    hint: '顺序 = 输出 JSON 里的键顺序；只支持 Streamable HTTP',
    configKey: 'MCP服务器',
    configGroup: 'MCP',
    collectionKey: 'mcpServers',
    importPlaceholder: '{"mcpServers":{"服务器名":{"type":"http","url":"http://127.0.0.1:3910/mcp"}}}',
    fileBase: 'aiplugin4-MCP服务器配置',
    storageKey: 'aiplugin4-config-mcp-draft',
    accept: '.json',
    fileHint: '支持标准 mcpServers JSON（Claude Desktop / Cursor 的 .mcp.json）；stdio / SSE 会跳过',
    emptyText: '还没有 MCP 服务器，点「+ 添加服务器」或把 .json 文件拖进来',
    fields: [
        { key: 'name', label: '服务器名（JSON 键）', type: 'text', required: true, placeholder: '如：mcp-files-exec', note: '唯一；作为 mcpServers 的键' },
        { key: 'platform', label: '平台白名单（扩展）', type: 'platform', placeholder: 'QQ, DISCORD（留空 = 所有平台）' },
        { key: 'type', label: '传输类型', type: 'select', options: [['http', 'http（Streamable HTTP）'], ['streamable-http', 'streamable-http']] },
        {
            key: 'capability',
            label: '能力声明 capability（扩展）',
            type: 'select',
            options: [['', '不填'], ['image-host', 'image-host（图床）']],
            note: 'image-host = 该服务器提供图床画廊能力（image_search / image_keep / image_unkeep / image_tag），插件据此注册图床适配器。旧字段 imageRefs 仍可导入。',
        },
        { key: 'url', label: 'URL', type: 'text', required: true, placeholder: 'http://127.0.0.1:3910/mcp' },
        { key: 'token', label: 'Token（简写）', type: 'secret', placeholder: '可选；导出时合并成 Authorization: Bearer …', note: '标准字段是 headers；这里只是输入简写' },
        { key: 'headers', label: 'Headers（JSON）', type: 'json', rows: 5, placeholder: '{"Authorization": "Bearer token"}', note: '可选；Authorization 优先于 Token' },
    ],
    defaults: DEFAULT_MCP,
    newItem: newServer,
    normalizeItem(item) { return normalizeServer(item); },
    validate: validateServers,
    build: buildMcp,
    parseImport: parseMcpImport,
    fromFile: mcpFromFile,
    maskConfig: maskMcp,
    supportMask: true,
    cardMeta(item) {
        return `${platformLabel(item.platform)} · ${item.url}${item.capability ? ' · ' + item.capability : ''}`;
    },
    usage: [
        '点「+ 添加服务器」或卡片上的「编辑」；也可以把标准 .mcp.json 文件拖进左侧。',
        '输出是标准 MCP JSON：顶层 mcpServers 对象，键 = 服务器名；platform / capability 是 aiplugin4 扩展字段。',
        '「能力声明 capability」填 image-host = 该服务器提供图床能力（image_search / image_keep / image_unkeep / image_tag），插件据此注册图床适配器。旧字段 imageRefs:true 仍可导入/导出（它只管工具结果的图片引用规范化，语义不同，不互替）。',
        '卡片头的「启用」开关只决定是否把该服务器写进生成配置（关闭 = 直接移除，不写 enabled 字段）。',
        '点「复制全部」，粘到海豹 → JS插件 → 插件设置 → aiplugin4 →「MCP」→「MCP服务器」。',
        '粘完用 .ai mcp refresh 立即生效；别忘了在「MCP」页打开「是否启用MCP」。',
    ],
};
