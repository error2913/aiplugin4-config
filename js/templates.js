// 供应商模板数据。
// 数据来源：aiplugin4 仓库 src/config/static_config/providers.ts（PROVIDER_MAP）。
// provider 取值是插件内部标识，不是显示名 —— Gemini 要填 "google"、Claude 要填 "anthropic"。
//
// cors 字段来自 2026 年实测（见 docs/13-模型配置v5方案.md 9.3.1）：
//   'allow'      浏览器可直连 /models（已实测放行）
//   'block'      CORS 拦截（网络可达但被拒）
//   'unreach'    本机网络不可达（DNS 干扰/被墙），CORS 状态未知
// 国内厂商全部放行，所以「自动拉取模型列表」可作主入口。

// 注意：这里**没有**「目标插件版本」常量。
// 曾经有过一个 TARGET_PLUGIN_VERSION = '5.0.0' 用在顶栏徽章上 —— 那是**错的**：
// "v5" 指的是**配置格式**，不是插件版本；插件版本是 4.2x（v5 配置随 4.25 发布）。
// 徽章本身也已按要求删掉，常量随之删除，避免留一个会误导的版本号。

/** 协议方言（对应 v5 的 providers[].api） */
export const API_DIALECTS = [
    { value: 'openai-completions', label: 'OpenAI Chat Completions', hint: '绝大多数厂商与中转站' },
    { value: 'anthropic-messages', label: 'Anthropic Messages', hint: 'Claude 及兼容 Messages 的中转站' },
    { value: 'openai-responses', label: 'OpenAI Responses', hint: 'Codex 已强制此协议；插件侧待实现' },
];

export const PROVIDER_TEMPLATES = [
    { id: 'deepseek', label: 'DeepSeek', provider: 'deepseek', api: 'openai-completions',
      baseUrl: 'https://api.deepseek.com/v1', cors: 'allow',
      modelHints: ['deepseek-flash', 'deepseek-pro'],
      notes: 'flash 可识图，pro 是文本。.ai balance 可查余额。' },
    { id: 'zhipu', label: '智谱 GLM', provider: 'zhipu', api: 'openai-completions',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4', cors: 'allow',
      modelHints: ['glm-4-plus', 'glm-4v'],
      notes: 'glm-4v 系列为视觉模型，需声明 kind = vision。' },
    { id: 'alibaba', label: '阿里百炼', provider: 'alibaba', api: 'openai-completions',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', cors: 'allow',
      modelHints: ['qwen-plus', 'text-embedding-v4', 'qwen-image-3.0-pro', 'qwen-audio-3.1-tts-flash', 'wanx2.1-t2i-turbo'],
      // 百炼**只有一个入口**。曾经还有个「百炼原生」模板，已删除 —— 理由是插件侧做了兼容层：
      //   · 生图：qwen-image 走兼容模式 /images/generations；wanx 走原生异步（预设里按模型名分流）
      //   · TTS ：Qwen-Audio / CosyVoice 走**主机根**的原生端点（预设用 {origin} 表达，
      //            与基址的路径前缀无关）
      // 所以"选兼容模式还是原生"这件事不该让用户决定 —— 插件按模型名自己分流。
      //
      // 这条注释曾经写的是「原生异步接口（wanx）请用自定义 URL」—— 直接把用户赶去填自定义 URL，
      // 而实际上兼容模式**已经支持 qwen-image 同步生图**（官方文档 POST /compatible-mode/v1/images/generations）。
      notes: '对话 / 嵌入 / 生图 / 语音合成都走这条，不用填 URL。' },
    { id: 'google', label: 'Google Gemini', provider: 'google', api: 'openai-completions',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', cors: 'unreach',
      modelHints: ['gemini-2.5-flash', 'gemini-embedding-001'],
      notes: 'provider 填 google（不是 gemini）。国内需自备代理。' },
    { id: 'anthropic', label: 'Anthropic Claude', provider: 'anthropic', api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com/v1', cors: 'block',
      modelHints: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
      notes: '流式会自动回退；浏览器直连被 CORS 拦，模型名手动填。' },
    { id: 'openai', label: 'OpenAI', provider: 'openai', api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1', cors: 'unreach',
      modelHints: ['gpt-4o', 'text-embedding-3-small'], notes: '国内需自备代理。' },
    { id: 'moonshot', label: 'Moonshot 月之暗面', provider: 'moonshot', api: 'openai-completions',
      baseUrl: 'https://api.moonshot.cn/v1', cors: 'allow',
      modelHints: ['kimi-k2-0905-preview'], notes: '内置余额查询。' },
    { id: 'siliconflow', label: '硅基流动', provider: 'siliconflow', api: 'openai-completions',
      baseUrl: 'https://api.siliconflow.cn/v1', cors: 'allow',
      modelHints: ['deepseek-ai/DeepSeek-V3'],
      notes: '内置余额查询；模型名多含斜杠。' },
    { id: 'xai', label: 'xAI Grok', provider: 'xai', api: 'openai-completions',
      baseUrl: 'https://api.x.ai/v1', cors: 'unreach', modelHints: ['grok-4'], notes: '国内需自备代理。' },
    { id: 'mistral', label: 'Mistral', provider: 'mistral', api: 'openai-completions',
      baseUrl: 'https://api.mistral.ai/v1', cors: 'unreach',
      modelHints: ['mistral-large-latest', 'mistral-embed'], notes: '国内需自备代理。' },
    { id: 'custom', label: '自定义 / 中转站', provider: '', api: 'openai-completions',
      baseUrl: '', cors: 'unknown', modelHints: [],
      notes: 'one-api / new-api / 自建等。必须自己填 URL。' },
];

/** 模型类型（对应 v5 的 models[].kind） */
export const MODEL_KINDS = [
    { value: 'text', label: '文本', desc: '对话候选（默认）' },
    { value: 'vision', label: '视觉', desc: '支持图像输入' },
    { value: 'embed', label: '嵌入', desc: '向量记忆，不参与对话' },
    { value: 'gen', label: '生图', desc: '图像生成' },
    { value: 'tts', label: '语音', desc: '语音合成' },
];
export const KIND_VALUES = MODEL_KINDS.map(k => k.value);

export function getTemplate(id) {
    return PROVIDER_TEMPLATES.find(t => t.id === id) || PROVIDER_TEMPLATES[PROVIDER_TEMPLATES.length - 1];
}

/**
 * 由 baseURL 的 host 识别 vendor（供应商标识）。
 *
 * 为什么需要：插件的 `media_presets`（媒体请求 body 结构）与 `balance`（内置余额端点）
 * 都按 **vendor** 索引，而不是按 `api` 协议（十几个 vendor vs 3 个协议）。
 * 但让用户手填 vendor 是负担，所以**从 URL 自动识别**。
 *
 * 这与插件现有的做法一致 —— `balance.ts:70` 本来就在做 `host.includes('api.deepseek.com')`。
 * 插件侧会把同一张表（PROVIDER_MAP）反过来用：v4 是 vendor→默认URL，v5 是 host→vendor。
 *
 * @returns {string} vendor 名；识别不出返回 ''（插件按 OpenAI 兼容处理）
 */
export function resolveVendorFromUrl(baseURL) {
    const u = String(baseURL || '').trim();
    if (!u) return '';
    let host = '';
    try { host = new URL(u).hostname.toLowerCase(); } catch { return ''; }
    if (!host) return '';
    const hit = PROVIDER_TEMPLATES.find(t => {
        if (!t.baseUrl) return false;
        try { return new URL(t.baseUrl).hostname.toLowerCase() === host; } catch { return false; }
    });
    if (hit) return hit.provider;
    // host 认不出 → 按**路径尾段**再试一次（见 MEDIA_ENDPOINT_SUFFIXES）
    return vendorByEndpointPath(u);
}

/**
 * vendor **独有的**媒体端点路径 → vendor。
 *
 * 为什么生成器也需要它：**必须与插件的 `resolveVendor` 判定一致**。
 * 插件那边（`vendor.ts`）在 host 认不出时会按路径再试一次；生成器若只看 host，
 * 界面就会显示「未识别」而插件实际用了 dashscope —— **显示与实际不符**，
 * 用户据此判断就会做错决定。
 *
 * 典型场景：把百炼原生的完整端点当 baseURL 填（v4 的 api连接就是这么填的）：
 *   https://llm-xxxx.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 * 专属部署域名不在 PROVIDER_MAP 里 → host 认不出 → 但**路径是唯一的**，据此可安全反查。
 *
 * 这张表是**手抄**插件 `media_presets` 推导结果的（那边由代码从预设表自己算出来，
 * 见 `vendor.ts` 的 SUFFIX_TO_VENDOR），靠跨仓库联测 §G 逐条比对守卫。
 * 只收"恰好一个 vendor 拥有"的路径 —— `/images/generations`、`/audio/speech`
 * 被 6~7 家共用，拿它们反查会把自建网关误判成某一家。
 */
export const MEDIA_ENDPOINT_SUFFIXES = [
    ['/api/v1/services/aigc/multimodal-generation/generation', 'dashscope'],
    ['/api/v1/services/aigc/text2image/image-synthesis', 'dashscope'],
    ['/api/v1/services/audio/tts/SpeechSynthesizer', 'dashscope'],
    ['/v2beta/stable-image/generate/ultra', 'stability'],
    ['/v2beta/stable-image/generate/core', 'stability'],
    ['/v1beta1/text:synthesize', 'google-cloud'],
    ['/api/open/v3/speech/tts', 'fishaudio'],
    ['/t2a_v2', 'minimax'],
];

/** 按"vendor 独有的端点路径"反查（认不出返回 ''）；与插件 `vendorByUrlSuffix` 同规则 */
export function vendorByEndpointPath(url) {
    const clean = String(url || '').trim().split('#')[0].split('?')[0].replace(/\/+$/, '');
    if (!clean) return '';
    // 长的优先：避免短后缀误吃长 URL 的尾段
    for (const [suffix, vendor] of [...MEDIA_ENDPOINT_SUFFIXES].sort((a, b) => b[0].length - a[0].length)) {
        if (clean.endsWith(suffix)) return vendor;
    }
    return '';
}

/**
 * 选模板时该不该把 provider 写进配置。
 *
 * 默认**不写**（返回 ''）：v5 的设计是 provider 留空、由插件按 baseURL 反查（方案 2.3.2）——
 * 配置更紧凑，且用户之后把 URL 改到别的厂商时自动识别仍然正确。
 *
 * 有一类模板**必须写**：它的地址反查回来的不是它自己（现已无此类模板 —— 「百炼原生」已删除）。
 * 曾经只有「百炼原生」—— 它与「阿里百炼」共用 host `dashscope.aliyuncs.com`
 * （`resolveVendorFromUrl` 只看 host），反查必然得 `alibaba`。
 *
 * 这个值以前**从来没被写进草稿**（面板的 sel.onchange 只设了 templateId/api/baseURL），
 * 所以那个模板曾经等于失效：选了它，导出的配置里没有 provider，
 * 插件按 URL 反查得到 alibaba 或空（专属域名）→ 用错预设 → 把 `/images/generations`
 * 拼到原生路径后面 → 百炼回 400 `url error, please check url！`（端点与模型不匹配）。
 *
 * @param {{provider?:string, baseUrl?:string}} t 供应商模板
 * @returns {string} 要写进草稿的 provider（'' = 留空走自动识别）
 */
export function providerForTemplate(t) {
    if (!t || !t.provider) return '';
    return resolveVendorFromUrl(t.baseUrl) === t.provider ? '' : t.provider;
}

/**
 * 插件 `media_presets` 能识别的全部 vendor 键
 * （`src/config/static_config/media_presets.ts`，tts 11 个 ∪ image-generation 10 个 = 16 个）。
 *
 * 注意：这批 vendor **多于聊天的供应商模板** —— 它们大多是「只做媒体」的服务
 * （MiniMax / FishAudio / ElevenLabs / 百度 / 火山方舟 / 腾讯 TokenHub / Stability / Google Cloud）。
 * 只按聊天模板列选项会漏掉它们，导致这些用户无法指定供应商标识。
 */
export const MEDIA_VENDORS = [
    'openai', 'siliconflow', 'zhipu', 'dashscope', 'alibaba', 'google', 'google-cloud',
    'minimax', 'fishaudio', 'baidu', 'elevenlabs',
    'volcengine', 'tencent-tokenhub', 'gemini', 'stability', 'custom',
];

/**
 * vendor → 它**真的有预设**的媒体用途。
 *
 * 为什么需要：MEDIA_VENDORS 是两个用途的并集，其中有只做 tts 的（ElevenLabs）
 * 和只做生图的（Stability）。用户在「文生图」里选了 ElevenLabs，
 * 插件的 `resolveMediaPreset` 会**静默退回通用预设**（`table[key] ?? table['']`），
 * 请求打到 /images/generations 而 ElevenLabs 没有这个接口 —— 必然失败且没有提示。
 * UI 用这张表把不支持的用途标出来。
 *
 * 这张表是**手抄**插件 `media_presets.ts` 的，靠跨仓库联测 §G3 守卫一致性。
 * 写这张表时我就把 `google` 错标成了"也支持生图"（实际生图那栏是 `gemini`，两者在插件里是
 * 不同的键）—— 是 §G3 当场抓出来的，可见手抄确实需要守卫。
 */
export const MEDIA_VENDOR_USES = {
    openai: ['tts', 'image-generation'],
    siliconflow: ['tts', 'image-generation'],
    zhipu: ['tts', 'image-generation'],
    dashscope: ['tts', 'image-generation'],
    alibaba: ['tts', 'image-generation'],
    google: ['tts'],
    'google-cloud': ['tts'],
    minimax: ['tts'],
    fishaudio: ['tts'],
    baidu: ['tts'],
    elevenlabs: ['tts'],
    volcengine: ['image-generation'],
    'tencent-tokenhub': ['image-generation'],
    gemini: ['image-generation'],
    stability: ['image-generation'],
    custom: ['image-generation'],
};

/** vendor → 可读标签（用于建议列表；未收录的显示原名） */const VENDOR_LABELS = {
    openai: 'OpenAI',
    siliconflow: '硅基流动',
    zhipu: '智谱 GLM',
    dashscope: '百炼原生（dashscope）',
    alibaba: '阿里百炼（兼容模式）',
    google: 'Google Gemini（兼容入口）',
    'google-cloud': 'Google Cloud（原生 TTS）',
    minimax: 'MiniMax',
    fishaudio: 'FishAudio',
    baidu: '百度 AI 开放平台',
    elevenlabs: 'ElevenLabs',
    volcengine: '火山方舟',
    'tencent-tokenhub': '腾讯 TokenHub',
    gemini: 'Gemini（媒体）',
    stability: 'Stability AI',
    custom: '通用 / 自定义（OpenAI 兼容）',
    deepseek: 'DeepSeek',
    anthropic: 'Anthropic Claude',
    moonshot: 'Moonshot 月之暗面',
    xai: 'xAI Grok',
    mistral: 'Mistral',
};

/**
 * 供应商下拉选项 = 聊天模板的 vendor ∪ media_presets 的 vendor。
 * 显示 label（供应商名称），写入 value（插件内部 vendor 标识）。
 */
export const KNOWN_VENDORS = (() => {
    const seen = new Set();
    const out = [];
    const add = (v) => {
        if (!v || seen.has(v)) return;
        seen.add(v);
        out.push({ value: v, label: VENDOR_LABELS[v] || v });
    };
    PROVIDER_TEMPLATES.forEach(t => add(t.provider));
    MEDIA_VENDORS.forEach(add);
    return out.sort((a, b) => a.value.localeCompare(b.value));
})();

/** vendor 标识 → 可读供应商名称（未收录时原样返回） */
export function vendorLabel(vendor) {
    const hit = KNOWN_VENDORS.find(v => v.value === vendor);
    return hit ? hit.label : vendor;
}

/** 反查模板：给定 baseUrl/apiKey 之外的线索，猜用户当初选的是哪个模板 */
export function templateIdForBaseUrl(baseUrl, api) {
    const u = String(baseUrl || '').trim();
    if (!u) return 'custom';
    const hit = PROVIDER_TEMPLATES.find(t => t.baseUrl && t.baseUrl === u);
    return hit ? hit.id : 'custom';
}

/** 7 个用途（对应 v5 的 purposes） */
export const PURPOSES = [
    { key: 'chat', label: '对话', hint: '主对话' },
    { key: 'summarization', label: '总结', hint: '会话总结' },
    { key: 'judge', label: '评判', hint: '评分/判定' },
    { key: 'image-understanding', label: '图片识别', hint: '需 kind = vision' },
    { key: 'text-embedding', label: '向量记忆', hint: '需 kind = embed' },
    { key: 'tts', label: '语音合成', hint: '需 kind = tts' },
    { key: 'image-generation', label: '文生图', hint: '需 kind = gen' },
];
