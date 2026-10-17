// 模型类型分类：与 aiplugin4 的 src/model/catalog.ts **同源但不等同**。
//
// 关系（重要，勿改成"完全一致"）：
//   插件的 classifyModel 是**运行时兜底** —— 只在配置没写 kind 时用，必须保守，
//     猜错会把嵌入模型当对话模型，直接报错或浪费钱。所以它只对"终值类型"下判断。
//   本文件的分类是**生成器的建议** —— 用来给用户预填 kind，让配置显式化。
//     它可以是插件判定的**超集**（多认几个），但**绝不能与插件矛盾**。
//   不变量：插件判为 X 的，本文件也必须判为 X。反之不要求。
//
// 与插件的一处有意差异：插件用 `/^flux/i` 这类**锚定开头**的写法，
// 聚合平台的厂商前缀名（black-forest-labs/FLUX.1-schnell）识别不到；
// 这里放宽为词边界匹配，好在生成阶段就预填对。插件侧是否同步放宽见方案 4.3 备注。
//
// 判定顺序（与插件一致，不可调换）：
//   rerank → embed → gen → tts → text
// 注：语音必须在 gen 之后、且不能与 vision 混淆（gpt-4o-mini-tts 含 gpt-4o）。
//     插件里原本还有 vision 正则，删除后该约束自然消失，但顺序仍照旧。

const EMBED = [
    /(^|[^a-z0-9])text-embedding/i,
    /(^|[^a-z0-9])(?:embedding|embed)([^a-z0-9]|$)/i,
    /(^|[^a-z0-9])bge([^a-z0-9]|$)/i,
    /bge-large/i,
    /bce-embedding/i,
    /(^|[^a-z0-9])multimodal-embedding/i,
    /(^|[^a-z0-9])gemini-embedding/i,
    /-embed-v\d/i,
    /^mistral-embed$/i,
];

// 生图白名单。
// 注意：插件原版用的是 `/^flux/i`、`/^imagen/i` 等**锚定开头**的写法，
// 因此聚合平台上的「厂商前缀名」（black-forest-labs/FLUX.1-schnell）识别不到，
// 必须靠用户显式声明 [types]/kind。生成器作为**建议工具**放宽为词边界匹配，
// 以便预填正确的 kind（这是 9.3.3 的目的）。放宽后仍不会误伤：见 classify.test 的用例。
const GEN = [
    /dall-e/i,
    /gpt-image/i,
    /cogview/i,
    /wanx/i,
    /(^|[^a-z0-9])flux/i,
    /stable-diffusion/i,
    /(^|[^a-z0-9])sd3/i,
    /kolors/i,
    /hunyuan-image/i,
    /(^|[^a-z0-9])seedream/i,
    /(^|[^a-z0-9])midjourney/i,
    /(^|[^a-z0-9])imagen/i,
    /(^|[^a-z0-9])veo/i,
    // 阿里百炼 qwen-image 系列。与插件 catalog.ts 的 GENERIC_GEN_PATTERNS 同步
    // （那边漏了它会导致官方生图模型被当对话模型，用户每次都得手动改类型）。
    /(^|[^a-z0-9])qwen-image/i,
];

const TTS = [
    /(^|[^a-z0-9])tts([^a-z0-9]|$)/i,
    /cosyvoice/i,
    /fish-speech/i,
    /text-to-speech/i,
    /speech-synthesis/i,
    /(^|[^a-z0-9])speech-[0-9]/i,
    /(^|[^a-z0-9])sovits/i,
    /(^|[^a-z0-9])gpt-sovits/i,
    /chattts/i,
    /(^|[^a-z0-9])sambert/i,
    /(^|[^a-z0-9])azure.*speech/i,
    /(^|[^a-z0-9])edge-tts/i,
    /(^|[^a-z0-9])melo-?tts/i,
    /(^|[^a-z0-9])bark([^a-z0-9]|$)/i,
];

const matchAny = (name, pats) => pats.some(p => p.test(name));

/**
 * 按模型名猜 kind。
 * @param {string} name 模型名
 * @returns {'text'|'vision'|'embed'|'gen'|'tts'} 仅返回可确定判定的；不确定一律 'text'
 */
export function classifyModel(name) {
    const n = String(name || '');
    if (/reranker/i.test(n) || /rerank/i.test(n)) return 'gen';
    if (matchAny(n, EMBED)) return 'embed';
    if (matchAny(n, GEN)) return 'gen';
    if (matchAny(n, TTS)) return 'tts';
    // 不再猜 vision：模糊视觉正则已在插件侧删除（方案 4.3）
    return 'text';
}

/** 是否「猜得准」——即命中终值白名单。用于 UI 上标注"已识别/需确认" */
export function isConfident(name) {
    return classifyModel(name) !== 'text';
}

/**
 * 决定**写不写** `kind` —— 方案 9.3.3 的核心规则。
 *
 *   1. 用户手选           → 用用户选的（最高优先）
 *   2. 供应商自报能力位   → 用自报的（权威，如 DeepSeek 的 `input_modalities`）
 *   3. 名字命中终值白名单 → 用名字判定的（嵌入/生图/语音可确定）
 *   4. 都不确定           → **返回 undefined = 不写这个字段**
 *
 * 第 4 条是这套规则的关键，别改成 `return 'text'`：
 * 配置里的 `kind` 在插件侧是 `manual`，而 `catalog.ts:110` 是
 * `if (extra.manual) return [extra.manual]` —— **绝对优先、直接返回**，
 * 插件自己从 /models 读到的 `input_modalities` 根本不会被看。
 * 所以"猜一个 text"会把插件本来能正确识别的多模态模型**抹成纯文本**；
 * 留空反而让插件用 hints + 命名兜底各显其能。
 *
 * @param {{explicit?:string, meta?:string, name?:string}} o
 * @returns {string|undefined} kind，或 undefined 表示"不写"
 */
export function decideKind(o = {}) {
    if (o.explicit) return o.explicit;
    if (o.meta) return o.meta;
    const byName = classifyModel(o.name);
    return byName === 'text' ? undefined : byName;
}
