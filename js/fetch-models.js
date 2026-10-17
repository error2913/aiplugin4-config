// 模型列表拉取：浏览器直连供应商 GET {baseURL}/models。
//
// 重要前提（方案 9.3）：这是「尽力而为」能力。
// 浏览器强制 CORS，供应商不放行时请求会被拦下 —— 与 API Key 是否正确无关。
// 实测（2026）：国内厂商（deepseek/zhipu/alibaba/moonshot/siliconflow）与 OpenRouter 放行；
// Anthropic 拦截；openai/xai/mistral 在国内网络不可达。
//
// 安全约束（方案 9.4）：
//   - 绝不经公共 CORS 代理（会把 API Key 泄露给第三方）
//   - 绝不引入后端
//   - API Key 只发往用户填写的那个 baseURL
//
// **本文件同时负责读供应商自报的能力元数据**（方案 9.3.3）：
// 不少供应商在 /models 里直接说明模态（DeepSeek 的 `input_modalities`、OpenRouter 的
// `architecture.input_modalities`、Ollama 的 `capabilities` …）。这是**权威证据**，
// 比按模型名猜准得多 —— 尤其 v5 起插件不再靠命名推断视觉，不读它就会把
// 多模态模型错标成 text，而**错标的 kind 会写进配置、反向覆盖插件的正确判断**
// （catalog.ts:110 `if (extra.manual) return [extra.manual]`，manual 绝对优先）。

const DEFAULT_TIMEOUT_MS = 12000;

/** 拉取失败的分类，供 UI 给出可读文案 */
export class FetchError extends Error {
    constructor(kind, message, detail) {
        super(message);
        this.name = 'FetchError';
        this.kind = kind;       // cors | auth | notfound | network | timeout | empty
        this.detail = detail || '';
    }
}

/** 元数据里表示"视觉/嵌入"的取值（对应插件 list.ts 的 MODALITY_BY_META_VALUE） */
const META_VISION = new Set(['vision', 'vlm', 'multimodal', 'image', 'image-text-to-text', 'visual']);
const META_EMBED = new Set(['embedding', 'embed', 'text-embedding']);

/**
 * 从单个列表项推断 kind —— **只认正向证据，无证据返回 undefined**。
 *
 * 为什么不返回 'text'：插件的 extractHints 出于同样理由"只产出 vision/embed 正向证据"——
 * 网关的保守元数据（一律报 text）会把多模态模型降级成纯文本。而且一旦我们把
 * "没有证据"写成 `kind:"text"`，它会**钉死**在配置里、覆盖插件自己拉到的能力位。
 * 返回 undefined = 不写这个字段，让插件用它的 hints + 命名兜底去判断。
 *
 * @param {any} item /models 返回里的单个模型对象
 * @returns {'vision'|'embed'|'gen'|'tts'|undefined}
 */
export function kindFromMetadata(item) {
    if (!item || typeof item !== 'object') return undefined;

    // 1) 输入模态含图片/视频 → 视觉
    const inputs = item.architecture?.input_modalities ?? item.input_modalities;
    if (Array.isArray(inputs)) {
        if (inputs.some(m => typeof m === 'string' && /^(image|video)$/i.test(m.trim()))) return 'vision';
    }

    // 2) 输出模态含图片 → 生图；含音频 → 语音
    const outputs = item.architecture?.output_modalities ?? item.output_modalities;
    if (Array.isArray(outputs)) {
        const o = outputs.map(m => (typeof m === 'string' ? m.trim().toLowerCase() : ''));
        if (o.includes('image')) return 'gen';
        if (o.includes('audio') || o.includes('speech')) return 'tts';
    }

    // 3) 类型字段（LM Studio / vLLM 等）
    for (const f of [item.type, item.model_type, item.kind, item.task]) {
        if (typeof f !== 'string') continue;
        const v = f.trim().toLowerCase();
        if (META_VISION.has(v)) return 'vision';
        if (META_EMBED.has(v)) return 'embed';
    }

    // 4) capabilities（Ollama 等；数组或对象两种形态）
    const caps = item.capabilities;
    if (Array.isArray(caps)) {
        const c = caps.map(x => (typeof x === 'string' ? x.trim().toLowerCase() : ''));
        if (c.includes('vision')) return 'vision';
        if (c.includes('embedding')) return 'embed';
    } else if (caps && typeof caps === 'object') {
        if (caps.vision === true) return 'vision';
        if (caps.embedding === true) return 'embed';
    }

    // 5) 扁平布尔位
    if (item.supports_vision === true || item.vision === true) return 'vision';
    if (item.supports_embedding === true || item.embedding === true) return 'embed';

    return undefined;
}

/** 从单个列表项取展示名与上下文窗口（拿不到就省略） */
function metaOf(item) {
    if (!item || typeof item !== 'object') return {};
    const m = {};
    if (typeof item.name === 'string' && item.name.trim() && item.name.trim() !== item.id) {
        m.displayName = item.name.trim();
    }
    const cw = item.context_window ?? item.context_length ?? item.architecture?.context_length;
    if (typeof cw === 'number' && cw > 0) m.contextWindow = cw;
    return m;
}

/**
 * 从各种返回形状里取出模型条目。
 * @returns {{id:string, kind?:string, displayName?:string, contextWindow?:number}[]}
 */
function extractModelEntries(data) {
    const seen = new Set();
    const out = [];
    const push = (v) => {
        // 字符串项：只有名字，没有元数据 → kind 留空
        if (typeof v === 'string') {
            const id = v.trim();
            if (id && !seen.has(id)) { seen.add(id); out.push({ id }); }
            return;
        }
        if (!v || typeof v !== 'object' || typeof v.id !== 'string') return;
        const id = v.id.trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        const e = { id, ...metaOf(v) };
        const kind = kindFromMetadata(v);
        if (kind) e.kind = kind;
        out.push(e);
    };

    if (Array.isArray(data)) { data.forEach(push); return out; }
    if (!data || typeof data !== 'object') return out;
    // OpenAI / Anthropic / DeepSeek：{ data: [...] }
    if (Array.isArray(data.data)) data.data.forEach(push);
    // 部分网关：{ models: [...] }
    if (Array.isArray(data.models)) data.models.forEach(push);
    // 富化映射：{ models: { "id": {...} } }（键即请求 id，值可能带元数据）
    else if (data.models && typeof data.models === 'object') {
        for (const [k, v] of Object.entries(data.models)) {
            push(v && typeof v === 'object' ? { id: k, ...v } : k);
        }
    }
    return out;
}

/** 构造鉴权头：Anthropic 用 x-api-key，其余用 Authorization: Bearer */
function buildHeaders(api, apiKey) {
    const h = { Accept: 'application/json' };
    if (api === 'anthropic-messages') {
        h['x-api-key'] = apiKey;
        h['anthropic-version'] = '2023-06-01';
        // Anthropic 需要显式声明才允许浏览器直连
        h['anthropic-dangerous-direct-browser-access'] = 'true';
    } else {
        h['Authorization'] = `Bearer ${apiKey}`;
    }
    return h;
}

/**
 * 规范化 /models 地址：baseURL 已以 /models 结尾则原样用。
 *
 * 已知局限：**直接把完整接口端点当 baseURL 时，这里会拼出不存在的地址**。
 * 例如百炼原生的
 *   https://.../api/v1/services/aigc/multimodal-generation/generation
 * 会被拼成 `…/generation/models`（必然 404）。
 *
 * 这里**不做猜测式纠正**：本模块看不到插件的 media_presets，唯一能用的判据是
 * "路径段数很多"这类启发式，而它会把 `https://gw/a/b/c/d/v1` 这种**本来可用**的
 * 自建网关误判成端点、直接拒绝拉取 —— 那是把能用的弄坏。
 * 所以改为在失败文案里说清可能的原因（见下面的 notfound 分支），让用户自己判断。
 * 插件侧有预设表，能做精确判断，那边是硬拦截（list.ts 的 vendorByUrlSuffix 分支）。
 */
function modelsUrl(baseURL) {
    const base = String(baseURL || '').replace(/\/+$/, '');
    return /\/models$/.test(base) ? base : `${base}/models`;
}

/**
 * 拉取模型列表（含能力元数据）。
 * @param {{baseURL:string, api:string, apiKey:string, timeoutMs?:number}} opts
 * @returns {Promise<{id:string, kind?:string, displayName?:string, contextWindow?:number}[]>}
 * @throws {FetchError}
 */
export async function fetchModelList(opts) {
    const { baseURL, api, apiKey } = opts;
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const url = modelsUrl(baseURL);

    if (!baseURL) throw new FetchError('network', '请先填写 API URL');
    if (!apiKey) throw new FetchError('auth', '请先填写 API Key');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    let res;
    try {
        res = await fetch(url, { method: 'GET', headers: buildHeaders(api, apiKey), signal: ctrl.signal });
    } catch (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') {
            throw new FetchError('timeout', `请求超时（${Math.round(timeoutMs / 1000)} 秒）`, url);
        }
        // fetch 抛 TypeError：可能是 CORS 拦截，也可能是网络不通。
        // 用 no-cors 探测区分（no-cors 成功 = 网络可达，故上一步是 CORS）。
        let reachable = false;
        try {
            await fetch(url, { method: 'GET', mode: 'no-cors' });
            reachable = true;
        } catch { reachable = false; }
        if (reachable) {
            throw new FetchError('cors',
                '该服务商未开放浏览器直连（CORS 限制），请手动填写模型名',
                '这是浏览器的安全策略，与 API Key 是否正确无关。');
        }
        throw new FetchError('network', '网络不可达（可能被墙或需要代理）', url);
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
        throw new FetchError('auth', `API Key 无效或权限不足（HTTP ${res.status}）`, url);
    }
    if (res.status === 404) {
        throw new FetchError('notfound',
            '该地址没有 /models 接口，请手动填写模型名',
            '若你填的是**完整接口端点**（如百炼原生的 /api/v1/services/aigc/multimodal-generation/generation），'
            + '拼接后得到的是 <端点>/models、并不存在 —— 请改成基础地址（只到版本根，'
            + '如 https://dashscope.aliyuncs.com/compatible-mode/v1）。',
            url);
    }
    if (!res.ok) {
        throw new FetchError('network', `请求失败（HTTP ${res.status}）`, url);
    }

    let data;
    try {
        data = await res.json();
    } catch {
        throw new FetchError('empty', '返回内容不是 JSON，请手动填写模型名', url);
    }

    const entries = extractModelEntries(data);
    if (entries.length === 0) {
        throw new FetchError('empty', '返回里没有解析到模型，请手动填写模型名', url);
    }
    return entries;
}

/**
 * 拉取结果的排序：未标注/文本类在前，视觉次之，嵌入/生图/语音在后（便于挑选）。
 * 未标注的（kind 为空）与 text 同序 —— 它们多半就是对话模型。
 */
export function sortModelEntries(entries) {
    const order = { text: 0, vision: 1, embed: 2, gen: 3, tts: 4 };
    return [...entries].sort((a, b) => {
        const d = (order[a.kind] ?? 0) - (order[b.kind] ?? 0);
        return d !== 0 ? d : a.id.localeCompare(b.id);
    });
}
