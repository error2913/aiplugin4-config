// 联网配置生成器的纯逻辑：预设 / 校验 / 构建 / 序列化 / 导入。
// 对应插件侧 src/web/schema.ts（v1）——字段、默认值、校验规则两边手抄，
// 由 aiplugin4 仓库 scripts/integration-config-generator.mjs 的跨仓库联测钉住漂移。
//
// 设计原则同 v5.js：本文件不碰 DOM，全部可被 node tests 直接 import。

export const WEB_VERSION = 1;

/** 全局默认项（插件侧缺省值一致） */
export const WEB_DEFAULTS = Object.freeze({
    count: 5,
    detail: 'summary',
    timeout: 20,
    maxContentChars: 4000,
    fallback: true,
});

export const WEB_DETAILS = ['snippet', 'summary', 'content'];

/**
 * 内置方言预设。baseURL 是**缺省值**：插件侧同样内置，配置里可省略；
 * 生成器为了直观会显式写进 JSON。
 *
 * 各家的请求/响应格式见 aiplugin4 仓库 docs/18 §6.7；生成器只负责选方言、填 Key，
 * 具体端点与取数路径由插件侧 preset 引擎实现（generic 则由用户自己写 JSON）。
 */
export const WEB_PRESETS = {
    deepseek: {
        label: 'DeepSeek',
        baseURL: 'https://api.deepseek.com',
        needKey: true,
        search: true,
        fetch: true,
        hint: '官方 Search / Fetch：POST /v1/tools/search、/v1/tools/fetch；5 元 / 1000 次成功请求，各 5 QPS',
    },
    searxng: {
        label: 'SearXNG',
        baseURL: 'https://searxng.fishwhite.top',
        needKey: false,
        search: true,
        fetch: false,
        hint: 'GET /search?q&format=json&pageno；兼容现有「联网搜索」；只支持搜索',
    },
    kimi: {
        label: 'Kimi (Moonshot)',
        baseURL: 'https://api.moonshot.ai',
        needKey: true,
        search: true,
        fetch: true,
        hint: 'POST /v1/tools/search（Basic）/search_pro（Pro）、/v1/tools/fetch；Bearer；Basic 用 text_query/limit/include_content；国内可换 api.moonshot.cn',
    },
    brave: {
        label: 'Brave Search',
        baseURL: 'https://api.search.brave.com',
        needKey: true,
        search: true,
        fetch: false,
        hint: 'GET /res/v1/web/search；鉴权头 X-Subscription-Token；count 1~20、offset ≤9',
    },
    tavily: {
        label: 'Tavily',
        baseURL: 'https://api.tavily.com',
        needKey: true,
        search: true,
        fetch: true,
        hint: 'POST /search（Bearer）；支持 include/exclude_domains、search_depth、include_raw_content；抓取走 /extract',
    },
    serper: {
        label: 'Serper (Google)',
        baseURL: 'https://google.serper.dev',
        needKey: true,
        search: true,
        fetch: false,
        hint: 'POST /search；鉴权头 X-API-KEY；返回 organic[]（Google 结果）+ knowledgeGraph 等',
    },
    bocha: {
        label: '博查 Bocha',
        baseURL: 'https://api.bocha.cn',
        needKey: true,
        search: true,
        fetch: false,
        hint: 'POST /v1/web-search（Bearer）；summary:true 才返回长摘要；结果在 data.webPages.value',
    },
    zhipu: {
        label: '智谱 Web Search',
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        needKey: true,
        search: true,
        fetch: false,
        hint: 'POST /web_search（Bearer）；必须带 search_engine（默认 search_std），count 1~50',
    },
    exa: {
        label: 'Exa',
        baseURL: 'https://api.exa.ai',
        needKey: true,
        search: true,
        fetch: true,
        hint: 'POST /search（x-api-key）；contents.text 取正文；抓取走 /contents',
    },
    firecrawl: {
        label: 'Firecrawl',
        baseURL: 'https://api.firecrawl.dev/v1',
        needKey: true,
        search: true,
        fetch: true,
        hint: 'POST /search（Bearer）；scrapeOptions.formats=["markdown"] 直接返回正文；抓取走 /scrape',
    },
    generic: {
        label: '自定义（generic）',
        baseURL: '',
        needKey: false,
        search: true,
        fetch: true,
        hint: '用 JSON 描述任意 HTTP 搜索/抓取接口：请求模板 + 响应取数路径；Jina Reader 等也走这里',
    },
};

export const WEB_DIALECTS = Object.keys(WEB_PRESETS);

/** generic 默认请求描述（模板占位符见 web-app.js 的提示文案） */
export const DEFAULT_GENERIC_SEARCH = {
    method: 'POST',
    path: '/v1/search',
    headers: {},
    body: { q: '{query}', limit: '{count}', full: '{need_content}' },
    results_path: 'data.items',
    fields: {
        title: 'name',
        url: 'link',
        snippet: 'description',
        summary: 'abstract',
        content: 'body',
    },
};

export const DEFAULT_GENERIC_FETCH = {
    method: 'GET',
    path: '/reader?url={url}',
    response_type: 'json',
    title_path: 'title',
    content_path: 'content',
};

export function presetOf(dialect) {
    return WEB_PRESETS[dialect] || WEB_PRESETS.generic;
}

export function makeProvider(dialect, uid) {
    const preset = presetOf(dialect);
    return {
        uid,
        id: dialect,
        dialect,
        baseURL: preset.baseURL || '',
        apiKey: '',
        enabled: true,
        timeout: '',
        headers: '',
        searchJson: dialect === 'generic' ? JSON.stringify(DEFAULT_GENERIC_SEARCH, null, 2) : '',
        fetchJson: dialect === 'generic' ? JSON.stringify(DEFAULT_GENERIC_FETCH, null, 2) : '',
    };
}

/** 归一化默认项：非法值退回缺省（生成器不因一个空输入就产出坏配置） */
export function normalizeDefaults(d) {
    const src = d && typeof d === 'object' ? d : {};
    const count = Number(src.count);
    const timeout = Number(src.timeout);
    const maxContentChars = Number(src.maxContentChars);
    return {
        count: Number.isFinite(count) && count >= 1 && count <= 50 ? Math.floor(count) : WEB_DEFAULTS.count,
        detail: WEB_DETAILS.includes(src.detail) ? src.detail : WEB_DEFAULTS.detail,
        timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : WEB_DEFAULTS.timeout,
        maxContentChars: Number.isFinite(maxContentChars) && maxContentChars > 0 ? Math.floor(maxContentChars) : WEB_DEFAULTS.maxContentChars,
        fallback: src.fallback !== false,
    };
}

function parseJson(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: true, value: null };
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

/** provider 是否支持抓取（generic 以是否填了 fetch 描述为准） */
export function supportsFetch(p) {
    if (!p || p.enabled === false) return false;
    if (p.dialect !== 'generic') return !!presetOf(p.dialect).fetch;
    const r = parseJson(p.fetchJson);
    return r.ok && !!r.value;
}

/**
 * 校验生成器状态。返回 { problems, warnings }：
 *   problems 阻止复制（结构性错误）；warnings 只提示（如 DeepSeek 未填 Key）。
 */
export function validateWeb(providers, defaults) {
    const problems = [];
    const warnings = [];
    const push = (arr, path, msg) => arr.push({ path, msg });

    if (!Array.isArray(providers) || providers.length === 0) {
        push(problems, '$.providers', '至少需要一个 provider（点「+ 添加 provider」）');
        return { problems, warnings };
    }

    const ids = new Set();
    providers.forEach((p, i) => {
        const pp = `$.providers[${i}]`;
        if (!WEB_PRESETS[p.dialect]) {
            push(problems, `${pp}.dialect`, `未知方言 ${JSON.stringify(p.dialect)}（可选：${WEB_DIALECTS.join(' / ')}）`);
        }
        if (!p.id) {
            push(problems, `${pp}.id`, '缺少 id');
        } else if (ids.has(p.id)) {
            push(problems, `${pp}.id`, `id 重复：${p.id}`);
        } else {
            ids.add(p.id);
        }

        if (p.dialect === 'deepseek' && !String(p.apiKey || '').trim()) {
            push(warnings, `${pp}.apiKey`, '未填 API Key：插件会跳过该 provider（不发注定 401 的请求）');
        }

        if (p.dialect === 'generic') {
            if (!String(p.baseURL || '').trim()) {
                push(problems, `${pp}.baseURL`, 'generic 必须填 baseURL');
            }
            const search = parseJson(p.searchJson);
            const fetch = parseJson(p.fetchJson);
            if (!search.ok) push(problems, `${pp}.search`, `search 描述不是合法 JSON：${search.error}`);
            if (!fetch.ok) push(problems, `${pp}.fetch`, `fetch 描述不是合法 JSON：${fetch.error}`);
            if (search.ok && fetch.ok && !search.value && !fetch.value) {
                push(problems, `${pp}.search`, 'search 与 fetch 至少填一个（当前都为空）');
            }
            if (search.ok && search.value && !search.value.results_path) {
                push(warnings, `${pp}.search.results_path`, '未写 results_path：插件按默认 "results" 取结果数组');
            }
        }

        const headers = parseJson(p.headers);
        if (!headers.ok) push(problems, `${pp}.headers`, `headers 不是合法 JSON：${headers.error}`);
        if (headers.ok && headers.value && (typeof headers.value !== 'object' || Array.isArray(headers.value))) {
            push(problems, `${pp}.headers`, 'headers 必须是 JSON 对象');
        }

        const timeout = Number(p.timeout);
        if (p.timeout !== '' && p.timeout !== null && (!Number.isFinite(timeout) || timeout <= 0)) {
            push(problems, `${pp}.timeout`, 'timeout 需为正数（秒）');
        }
    });

    const d = defaults && typeof defaults === 'object' ? defaults : {};
    if (d.count !== undefined && d.count !== '') {
        const v = Number(d.count);
        if (!Number.isFinite(v) || v < 1 || v > 50) push(problems, '$.defaults.count', 'count 需在 1~50 之间');
    }
    if (d.timeout !== undefined && d.timeout !== '') {
        const v = Number(d.timeout);
        if (!Number.isFinite(v) || v <= 0) push(problems, '$.defaults.timeout', 'timeout 需为正数（秒）');
    }
    if (d.maxContentChars !== undefined && d.maxContentChars !== '') {
        const v = Number(d.maxContentChars);
        if (!Number.isFinite(v) || v <= 0) push(problems, '$.defaults.maxContentChars', 'maxContentChars 需为正数');
    }
    if (d.detail !== undefined && !WEB_DETAILS.includes(d.detail)) {
        push(problems, '$.defaults.detail', `detail 只能是 ${WEB_DETAILS.join(' / ')}`);
    }

    return { problems, warnings };
}

/** 构建最终配置对象（不含遮蔽）。只输出与缺省不同的字段，尽量小。 */
export function buildWeb(providers, defaults) {
    const d = normalizeDefaults(defaults);
    const providersOut = providers.map(p => {
        const o = { id: p.id, dialect: p.dialect };
        const base = String(p.baseURL || '').trim();
        if (base) o.baseURL = base;
        const key = String(p.apiKey || '').trim();
        if (key) o.apiKey = key;
        if (p.enabled === false) o.enabled = false;
        const timeout = Number(p.timeout);
        if (p.timeout !== '' && Number.isFinite(timeout) && timeout > 0) o.timeout = timeout;
        const headers = parseJson(p.headers);
        if (headers.ok && headers.value && typeof headers.value === 'object' && !Array.isArray(headers.value)) {
            o.headers = headers.value;
        }
        if (p.dialect === 'generic') {
            const s = parseJson(p.searchJson);
            const f = parseJson(p.fetchJson);
            if (s.ok && s.value) o.search = s.value;
            if (f.ok && f.value) o.fetch = f.value;
        }
        return o;
    });

    const cfg = { version: WEB_VERSION, defaults: d, providers: providersOut };
    const searchIds = providersOut.map(p => p.id);
    const fetchIds = providers.filter(p => supportsFetch(p)).map(p => p.id);
    if (searchIds.length) cfg.routes = { search: searchIds };
    if (fetchIds.length) cfg.routes = { ...(cfg.routes || {}), fetch: fetchIds };
    return cfg;
}

export function serializeWeb(cfg, pretty = false) {
    return pretty ? JSON.stringify(cfg, null, 2) : JSON.stringify(cfg);
}

/** 遮蔽所有 apiKey（分享截图用；不修改入参） */
export function maskWebKeys(cfg) {
    const copy = JSON.parse(JSON.stringify(cfg));
    if (Array.isArray(copy.providers)) {
        for (const p of copy.providers) {
            if (p.apiKey) p.apiKey = 'sk-xxxx';
        }
    }
    return copy;
}

/**
 * 导入：把「联网配置」文本还原成生成器状态。
 * 结构不合法抛 Error；其余尽量宽松（缺 id 自动补、缺默认项用缺省）。
 */
export function parseWebImport(text) {
    let raw;
    try {
        raw = JSON.parse(String(text || '').trim());
    } catch (e) {
        throw new Error(`不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('配置必须是一个 JSON 对象');
    }
    if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
        throw new Error('缺少非空的 providers 数组');
    }

    const providers = raw.providers.map((p, i) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) {
            throw new Error(`providers[${i}] 必须是对象`);
        }
        const dialect = typeof p.dialect === 'string' ? p.dialect : '';
        if (!WEB_PRESETS[dialect]) {
            throw new Error(`providers[${i}].dialect 非法：${JSON.stringify(p.dialect)}（可选：${WEB_DIALECTS.join(' / ')}）`);
        }
        const preset = presetOf(dialect);
        return {
            uid: `w${i + 1}`,
            id: typeof p.id === 'string' && p.id.trim() ? p.id.trim() : dialect,
            dialect,
            baseURL: typeof p.baseURL === 'string' && p.baseURL.trim() ? p.baseURL.trim() : (preset.baseURL || ''),
            apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
            enabled: p.enabled !== false,
            timeout: p.timeout !== undefined && p.timeout !== null ? String(p.timeout) : '',
            headers: p.headers && typeof p.headers === 'object' ? JSON.stringify(p.headers, null, 2) : '',
            searchJson: p.search && typeof p.search === 'object' ? JSON.stringify(p.search, null, 2) : '',
            fetchJson: p.fetch && typeof p.fetch === 'object' ? JSON.stringify(p.fetch, null, 2) : '',
        };
    });

    // id 去重（导入一份手写重复 id 的配置时不至于直接崩，但保持可见）
    const seen = new Set();
    for (const p of providers) {
        if (seen.has(p.id)) p.id = `${p.id}-${seen.size + 1}`;
        seen.add(p.id);
    }

    return {
        providers,
        defaults: normalizeDefaults(raw.defaults || {}),
    };
}
