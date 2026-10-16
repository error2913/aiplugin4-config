// TOML 生成：把表单状态渲染成「api连接」配置框内容。
//
// 本模块是正确性关键路径，规则全部来自 aiplugin4 源码（src/config/configs/model.ts）：
//   1. 每条连接渲染成一个独立字符串（对应插件里的一个配置框），框序即 connIndex。
//   2. [types] 必须写在本框最后 —— 其后不能再出现 api_key 等键，否则整框解析失败。
//      这里的做法是把 [types] 恒定排在末尾，从结构上杜绝该错误。
//   3. 模型名含 . : / 等字符时，[types] 的 key 必须加引号，否则被 TOML 解析成嵌套表。
//   4. provider 省略（空）时 base_url 必填；api_key 必填。
//   5. ignore = 1 表示忽略该连接。

/** TOML 基本字符串转义 */
function esc(s) {
    return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/[\n\r\t]/g, c => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t' }[c]));
}

/** TOML 基础键：仅 A-Za-z0-9_- 可裸写，其余需加引号 */
function key(k) {
    return /^[A-Za-z0-9_-]+$/.test(k) ? k : `"${esc(k)}"`;
}

/** 字符串数组字面量 */
function strArray(arr) {
    return `[${arr.map(v => `"${esc(v)}"`).join(', ')}]`;
}

/**
 * 校验一条连接，返回错误信息数组（空数组 = 通过）。
 * 对应插件 model.ts 的 buildModelConfig 校验，提前在页面拦住。
 */
export function validateConn(conn) {
    const errs = [];
    const provider = String(conn.provider || '').trim();
    const baseUrl = String(conn.baseUrl || '').trim();
    const apiKey = String(conn.apiKey || '').trim();

    if (apiKey === '') errs.push('api_key 必填');
    if (provider === '' && baseUrl === '') {
        errs.push('provider 留空时（按 OpenAI 兼容处理）必须填 base_url');
    }
    if (baseUrl !== '' && !/^https?:\/\//i.test(baseUrl)) {
        errs.push('base_url 需以 http:// 或 https:// 开头');
    }
    for (const m of conn.models || []) {
        if (String(m).trim() === '') errs.push('模型名不能为空');
    }
    return errs;
}

/**
 * 渲染一条连接为 TOML 字符串。
 * @param {object} conn 表单连接对象
 * @param {object} opts { maskKey:boolean } 遮蔽 api_key（导出分享用）
 * @returns {string}
 */
export function renderConn(conn, opts = {}) {
    const maskKey = !!opts.maskKey;
    const provider = String(conn.provider || '').trim();
    const baseUrl = String(conn.baseUrl || '').trim();
    const apiKeyRaw = String(conn.apiKey || '').trim();
    const apiKey = maskKey && apiKeyRaw ? 'sk-xxxx' : apiKeyRaw;

    // 钉住清单：填了才写 models（不写 = 启动时自动拉取）
    const models = (conn.models || []).map(m => String(m).trim()).filter(m => m !== '');

    // [types]：只保留确实需要声明的（text 是兜底默认，写不写等价，但显式声明也无害）
    const types = conn.types && typeof conn.types === 'object' ? conn.types : {};
    const typeEntries = Object.keys(types)
        .filter(k => models.includes(k))
        .map(k => [k, String(types[k]).trim().toLowerCase()]);

    const lines = [];
    lines.push(`api_key = "${esc(apiKey)}"`);
    if (provider) lines.push(`provider = "${esc(provider)}"`);
    if (baseUrl) lines.push(`base_url = "${esc(baseUrl)}"`);
    if (models.length > 0) lines.push(`models = ${strArray(models)}`);
    if (conn.ignore) lines.push('ignore = 1');

    // [types] 恒定最后：源头保证插件要求的「表必须在框末尾」不被违反
    if (typeEntries.length > 0) {
        lines.push('');
        lines.push('[types]');
        for (const [name, tag] of typeEntries) {
            lines.push(`${key(name)} = "${esc(tag)}"`);
        }
    }

    return lines.join('\n');
}

/**
 * 渲染全部连接：每个元素是一个配置框的内容（插件里「每框一个 API 连接」）。
 * @returns {string[]}
 */
export function renderAll(conns, opts = {}) {
    return (conns || [])
        .filter(c => c.enabled !== false)
        .map(c => renderConn(c, opts));
}

/**
 * 渲染全量导出文本：多个配置框用分隔注释拼接，便于用户逐框粘贴。
 * 注意：插件是「一框一条连接」，所以这里用显式分隔线标注框序，
 * 而不是产出一个可直接整体粘贴的单块 TOML（那在插件里会被当成一条连接）。
 */
export function renderExport(conns, opts = {}) {
    const blocks = renderAll(conns, opts);
    if (blocks.length === 0) return '';
    if (blocks.length === 1) return blocks[0];
    return blocks
        .map((b, i) => {
            const bar = '='.repeat(60);
            return `${bar}\naiplugin4「api连接」第 ${i} 框（连接序号 ${i}）—— 请整框粘贴到第 ${i + 1} 个框\n${bar}\n${b}`;
        })
        .join('\n\n');
}
