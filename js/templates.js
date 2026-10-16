// 供应商模板数据。
// 数据来源：aiplugin4 仓库 src/config/static_config/providers.ts（PROVIDER_MAP）。
// 注意：provider 取值是插件内部标识，不是显示名 —— Gemini 要填 "google"、Claude 要填 "anthropic"。
// 随插件升级，此处可能与上游漂移，页面顶部有版本标注；改动时请同步 PROVIDER_MAP。

/** 插件版本对齐点：本文件数据对应的 aiplugin4 版本 */
export const TARGET_PLUGIN_VERSION = '4.24.0';

/** 插件源码仓库（供用户核对） */
export const PLUGIN_REPO_URL = 'https://github.com/error2913/aiplugin4';

/**
 * 供应商模板。
 * - id       稳定标识，用于表单选中态（自定义项为 'custom'）
 * - provider 写入 TOML 的 provider 值；空串 = OpenAI 兼容（此时 base_url 必填）
 * - baseUrl  默认地址，可被用户覆盖
 * - modelHints 模型名填写示例（仅供 UI 提示，不写入配置）
 * - notes    UI 上的注意事项
 */
export const PROVIDER_TEMPLATES = [
    {
        id: 'deepseek',
        label: 'DeepSeek',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        modelHints: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
        notes: '内置余额查询，可用 .ai balance 直接查。',
    },
    {
        id: 'zhipu',
        label: '智谱 GLM',
        provider: 'zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        modelHints: ['glm-4-plus', 'glm-4v'],
        notes: 'glm-4v 系列为视觉模型，可绑定「图片识别」用途。',
    },
    {
        id: 'alibaba',
        label: '阿里百炼',
        provider: 'alibaba',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        modelHints: ['qwen-plus', 'text-embedding-v4'],
        notes: '兼容模式（OpenAI 形状）。原生异步接口请改用 provider "dashscope"。',
    },
    {
        id: 'google',
        label: 'Google Gemini',
        provider: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        modelHints: ['gemini-2.5-flash', 'gemini-embedding-001'],
        notes: 'provider 必须填 google（不是 gemini），此处走 OpenAI 兼容端点。',
    },
    {
        id: 'anthropic',
        label: 'Anthropic Claude',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        modelHints: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
        notes: '已适配请求/响应格式；流式暂不支持，配置 stream = true 会自动回退为非流式。',
    },
    {
        id: 'openai',
        label: 'OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        modelHints: ['gpt-4o', 'text-embedding-3-small'],
        notes: '',
    },
    {
        id: 'moonshot',
        label: 'Moonshot 月之暗面',
        provider: 'moonshot',
        baseUrl: 'https://api.moonshot.cn/v1',
        modelHints: ['kimi-k2-0905-preview'],
        notes: '内置余额查询，可用 .ai balance 直接查。',
    },
    {
        id: 'siliconflow',
        label: '硅基流动',
        provider: 'siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        modelHints: ['deepseek-ai/DeepSeek-V3'],
        notes: '内置余额查询；模型名多含斜杠，自动加引号无需手写。',
    },
    {
        id: 'xai',
        label: 'xAI Grok',
        provider: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        modelHints: ['grok-4'],
        notes: '',
    },
    {
        id: 'mistral',
        label: 'Mistral',
        provider: 'mistral',
        baseUrl: 'https://api.mistral.ai/v1',
        modelHints: ['mistral-large-latest', 'mistral-embed'],
        notes: '',
    },
    {
        id: 'custom',
        label: '自定义 / 网关',
        provider: '',
        baseUrl: '',
        modelHints: [],
        notes: 'one-api / new-api / 本地自建等。provider 留空 = 按 OpenAI 兼容处理，此时 base_url 必填。',
    },
];

/** 模型类型标签（对应「api连接」[types] 可声明值） */
export const MODEL_TAGS = [
    { value: 'text', label: '文本', desc: '对话候选（默认，通常无需声明）' },
    { value: 'vision', label: '视觉', desc: '支持图像输入，进入识图候选' },
    { value: 'embed', label: '嵌入', desc: '向量记忆用，不参与对话' },
    { value: 'gen', label: '生图', desc: '图像生成，非兼容服务需声明' },
    { value: 'tts', label: '语音', desc: '语音合成，非兼容服务需声明' },
];

export const TAG_VALUES = MODEL_TAGS.map(t => t.value);

/** 按 id 取模板 */
export function getTemplate(id) {
    return PROVIDER_TEMPLATES.find(t => t.id === id) || PROVIDER_TEMPLATES[PROVIDER_TEMPLATES.length - 1];
}

/**
 * 反查：给定 provider 值，猜一个模板 id。
 * 用于导入既有 TOML 时恢复选中态；匹配不到回落 custom。
 */
export function templateIdForProvider(provider) {
    const p = String(provider || '').trim().toLowerCase();
    if (p === '') return 'custom';
    const hit = PROVIDER_TEMPLATES.find(t => t.provider && t.provider.toLowerCase() === p);
    return hit ? hit.id : 'custom';
}
