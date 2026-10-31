// v5 逻辑测试（纯 Node，不需要浏览器）。
// 运行：node tests/run.mjs
import {
    validate, validateConfig, build, serialize, maskKeys, uniqueModelId, collectModelIds,
    isEligibleKind, bodyUsePurposesForKind, parseImport,
} from '../js/v5.js';
import { classifyModel, decideKind } from '../js/classify.js';
import {
    PROVIDER_TEMPLATES, API_DIALECTS, KIND_VALUES, PURPOSES, PURPOSE_MODEL_HINTS, resolveVendorFromUrl,
    KNOWN_VENDORS, MEDIA_VENDORS, MEDIA_VENDOR_USES, providerForTemplate,
    vendorByEndpointPath, MEDIA_ENDPOINT_SUFFIXES,
} from '../js/templates.js';
import { FetchError, kindFromMetadata } from '../js/fetch-models.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`); }
};

// provider 是可选的覆盖值：正常留空，由插件按 URL 识别（方案 2.3.2）
const goodProvider = (over = {}) => ({
    provider: '', api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-abc',
    models: [{ id: 'm1', name: 'gpt-4o', kind: 'text' }], ...over,
});

console.log('=== 供应商标识：由 URL 自动识别（用户不填） ===');
{
    const cases = [
        ['https://api.deepseek.com/v1', 'deepseek'],
        ['https://open.bigmodel.cn/api/paas/v4', 'zhipu'],
        ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'alibaba'],
        ['https://api.siliconflow.cn/v1', 'siliconflow'],
        ['https://api.anthropic.com/v1', 'anthropic'],
        ['https://generativelanguage.googleapis.com/v1beta/openai', 'google'],
        ['https://api.moonshot.cn/v1', 'moonshot'],
        ['https://api.openai.com/v1', 'openai'],
        ['https://gw.example.com/v1', ''],   // 未收录 → 按 OpenAI 兼容
        ['', ''],
        ['not-a-url', ''],
    ];
    for (const [u, exp] of cases) {
        check(`识别 ${u || '(空)'} → ${exp || '(未识别)'}`, resolveVendorFromUrl(u) === exp, resolveVendorFromUrl(u));
    }
    // 每个内置模板的默认地址都该能被识别回自己的 provider（防止模板与识别表漂移）。
    //
    // **例外：共用同一 host 的 vendor 无法靠 host 反查区分** —— 百炼的兼容模式
    // （`dashscope.aliyuncs.com/compatible-mode/v1` → alibaba）与原生接口
    // （`dashscope.aliyuncs.com` → 也想是 dashscope）host 相同，插件的 resolveVendor
    // 只看 host，必然都判成 alibaba。这类模板**必须显式写 provider** 才正确 ——
    // 所以下面单独断言"它确实显式写了"，而不是断言反查结果。
    const HOST_SHARED = new Set(['dashscope']);
    for (const t of PROVIDER_TEMPLATES.filter(x => x.id !== 'custom')) {
        if (HOST_SHARED.has(t.id)) {
            check(`模板 ${t.id} 与别的 vendor 共用 host，必须显式写 provider`,
                !!t.provider && t.provider === t.id,
                `provider=${t.provider}`);
            check(`  且它的地址确实会被误判成别的 vendor（说明显式写是必需的）`,
                resolveVendorFromUrl(t.baseUrl) !== t.provider,
                `${t.baseUrl} → ${resolveVendorFromUrl(t.baseUrl)}`);
            continue;
        }
        check(`模板 ${t.id} 的默认地址能识别回 ${t.provider}`,
            resolveVendorFromUrl(t.baseUrl) === t.provider,
            `${t.baseUrl} → ${resolveVendorFromUrl(t.baseUrl)}`);
    }
}

console.log('=== 分类（与插件同源，且是超集） ===');
{
    const cases = [
        ['deepseek-v4-flash', 'text'], ['text-embedding-v4', 'embed'], ['bge-m3', 'embed'],
        ['black-forest-labs/FLUX.1-schnell', 'gen'], ['dall-e-3', 'gen'],
        ['cosyvoice-v1', 'tts'], ['gpt-4o-mini-tts', 'tts'], ['some-reranker', 'gen'],
        ['gpt-4o', 'text'], ['glm-4v', 'text'],
        ['video-generation-helper', 'text'], ['influx-db-model', 'text'],
    ];
    for (const [n, exp] of cases) check(`classify(${n}) = ${exp}`, classifyModel(n) === exp, classifyModel(n));
}

console.log('\n=== 校验：合法配置 ===');
{
    check('最小合法配置无问题', validate([goodProvider()], {}).length === 0,
        JSON.stringify(validate([goodProvider()], {})));
    check('多连接合法', validate([goodProvider(), goodProvider({ id: 'p2', models: [{ id: 'm2', name: 'x' }] })], {}).length === 0);
    check('空模型清单合法（= 启动自动拉取）', validate([goodProvider({ models: [] })], {}).length === 0);
    check('缺 models 字段合法', validate([goodProvider({ models: undefined })], {}).length === 0);
}

console.log('\n=== 校验：必须拦住（每条对应方案 3.2） ===');
{
    const has = (probs, path) => probs.some(p => p.path === path);
    // provider 是可选覆盖值：留空合法（方案 2.3.2）
    check('provider 留空合法（自动识别）', validate([goodProvider({ provider: '' })], {}).length === 0,
        JSON.stringify(validate([goodProvider({ provider: '' })], {})));
    check('provider 缺字段合法', validate([goodProvider({ provider: undefined })], {}).length === 0);
    check('provider 显式指定也合法', validate([goodProvider({ provider: 'deepseek' })], {}).length === 0);
    check('api 非法', has(validate([goodProvider({ api: 'grpc' })], {}), '$.providers[0].api'));
    check('缺 baseURL', has(validate([goodProvider({ baseURL: '' })], {}), '$.providers[0].baseURL'));
    check('baseURL 缺协议头', has(validate([goodProvider({ baseURL: 'a.example/v1' })], {}), '$.providers[0].baseURL'));
    check('缺 apiKey', has(validate([goodProvider({ apiKey: '' })], {}), '$.providers[0].apiKey'));
    check('apiKey 含不可打印字符', has(validate([goodProvider({ apiKey: 'sk-a\nb' })], {}), '$.providers[0].apiKey'));
    check('模型 id 重复（跨 provider）',
        has(validate([goodProvider(), goodProvider({ id: 'p2' })], {}), '$.providers[1].models[0].id'));
    check('模型缺 name', has(validate([goodProvider({ models: [{ id: 'm1', name: '' }] })], {}), '$.providers[0].models[0].name'));
    check('kind 非法', has(validate([goodProvider({ models: [{ id: 'm1', name: 'x', kind: 'audio' }] })], {}), '$.providers[0].models[0].kind'));
    check('purposes 引用不存在',
        has(validate([goodProvider()], { chat: 'nope' }), '$.purposes.chat'));
    check('purposes 未知用途',
        has(validate([goodProvider()], { nonsense: 'm1' }), '$.purposes.nonsense'));
    check('空 providers 被拒', validate([], {}).some(p => p.path === '$.providers'));
}

console.log('\n=== 报错路径格式（方案 3.3） ===');
{
    const probs = validate([goodProvider(), goodProvider({ id: 'p2', models: [{ id: 'm1', name: '' }] })], { chat: 'ghost' });
    const paths = probs.map(p => p.path);
    check('路径形如 $.providers[1].models[0].name', paths.includes('$.providers[1].models[0].name'), JSON.stringify(paths));
    check('一次报出全部问题（>=3）', probs.length >= 3, String(probs.length));
}

console.log('\n=== 构建与序列化 ===');
{
    const cfg = build([goodProvider()], { chat: 'm1' });
    check('version = 5', cfg.version === 5);
    check('模型嵌套在 provider 内', Array.isArray(cfg.providers[0].models) && cfg.providers[0].models[0].id === 'm1');
    check('无顶层 models 字段', cfg.models === undefined);
    check('purposes 已写入为有序数组', Array.isArray(cfg.purposes.chat) && cfg.purposes.chat[0] === 'm1', JSON.stringify(cfg.purposes.chat));
    check('不再输出 groups（用途组请求体机制已随插件移除）', cfg.groups === undefined, JSON.stringify(cfg.groups));

    const dense = serialize(cfg);
    check('密集格式（无换行）', !dense.includes('\n'), dense.slice(0, 60));
    check('可被 JSON.parse 回读', JSON.parse(dense).version === 5);

    // 空模型清单：不写 models 字段
    const cfg2 = build([goodProvider({ models: [] })], {});
    check('空模型清单不写 models 字段', cfg2.providers[0].models === undefined, JSON.stringify(cfg2.providers[0]));
    check('空 purposes 不写该字段', cfg2.purposes === undefined);
    check('空模型清单仍不写 groups', cfg2.groups === undefined);

    // 启用开关：停用的连接直接移除，不写 enabled 字段；绑定到它模型的用途一并过滤
    const off = goodProvider({ enabled: false });
    const cfgOff = build([off], { chat: 'm1' });
    check('停用连接从输出移除', cfgOff.providers.length === 0, JSON.stringify(cfgOff.providers));
    check('停用连接的用途绑定被过滤', cfgOff.purposes === undefined, JSON.stringify(cfgOff.purposes));
    check('输出不含 enabled 键', !serialize(cfgOff).includes('"enabled"'));
    const mixed = build([goodProvider({ enabled: false, apiKey: '' }), goodProvider({ id: 'p2', models: [{ id: 'm2', name: 'x' }] })], { chat: 'm2' });
    check('停用连接不参与输出', mixed.providers.length === 1 && mixed.providers[0].models[0].id === 'm2', JSON.stringify(mixed.providers));
    check('停用连接的空 Key 不阻塞校验', validate([goodProvider({ enabled: false, apiKey: '' }), goodProvider({ id: 'p2', models: [{ id: 'm2', name: 'x' }] })], {}).length === 0);
}

console.log('\n=== 遮蔽 API Key ===');
{
    const cfg = build([goodProvider()], {});
    const masked = maskKeys(cfg);
    check('遮蔽后为占位符', masked.providers[0].apiKey === 'sk-xxxx');
    check('遮蔽不泄露原 key', !serialize(masked).includes('sk-abc'));
    check('遮蔽不改动原对象', cfg.providers[0].apiKey === 'sk-abc');
}

console.log('\n=== id 生成与去重 ===');
{
    const existing = new Set(['flash']);
    check('斜杠转连字符', uniqueModelId('black-forest-labs/FLUX.1-schnell', new Set()) === 'black-forest-labs-flux-1-schnell',
        uniqueModelId('black-forest-labs/FLUX.1-schnell', new Set()));
    check('冲突加序号', uniqueModelId('flash', existing) === 'flash-2', uniqueModelId('flash', existing));
    check('大写转小写', uniqueModelId('GLM-4V', new Set()) === 'glm-4v');
    check('空名有兜底', uniqueModelId('', new Set()) === 'model');
    const ids = collectModelIds([goodProvider(), goodProvider({ id: 'p2', models: [{ id: 'm2', name: 'y' }] })]);
    check('collectModelIds 收集全部', ids.has('m1') && ids.has('m2'));
}

console.log('\n=== 用途 × 模型类型（必须与插件 isEligible 一致） ===');
{
    const el = (use, kind) => isEligibleKind(use, kind);
    // 终值用途：只接受对应类型
    check('text-embedding 只接受 embed', el('text-embedding', 'embed') && !el('text-embedding', 'text'), '');
    check('image-understanding 只接受 vision', el('image-understanding', 'vision') && !el('image-understanding', 'text'));
    check('image-generation 只接受 gen', el('image-generation', 'gen') && !el('image-generation', 'text'));
    check('tts 只接受 tts', el('tts', 'tts') && !el('tts', 'text'));
    // 对话类：排除 embed/gen/tts
    for (const u of ['chat', 'summarization', 'judge']) {
        check(`${u} 接受 text`, el(u, 'text'));
        check(`${u} 接受 vision`, el(u, 'vision'));
        check(`${u} 排除 embed`, !el(u, 'embed'));
        check(`${u} 排除 gen`, !el(u, 'gen'));
        check(`${u} 排除 tts`, !el(u, 'tts'));
    }
    // kind 缺省视为 text
    check('kind 缺省按 text 处理', el('chat', undefined) && !el('text-embedding', undefined));
}

console.log('\n=== 校验：用途绑定的类型必须匹配 ===');
{
    const has = (probs, path) => probs.some(p => p.path === path);
    // 把一个 text 模型绑到 image-generation：插件会忽略，生成器必须拦住
    const bad = validate([goodProvider({ models: [{ id: 'm1', name: 'gpt-4o', kind: 'text' }] })],
        { 'image-generation': 'm1' });
    check('text 模型绑到 image-generation 被拒', has(bad, '$.purposes.image-generation'), JSON.stringify(bad));
    // 正确类型可以通过
    const ok = validate([goodProvider({ models: [{ id: 'm1', name: 'flux', kind: 'gen' }] })],
        { 'image-generation': 'm1' });
    check('gen 模型绑到 image-generation 通过', ok.length === 0, JSON.stringify(ok));
    // 嵌入模型不能当对话
    check('embed 模型绑到 chat 被拒',
        has(validate([goodProvider({ models: [{ id: 'm1', name: 'bge-m3', kind: 'embed' }] })], { chat: 'm1' }),
            '$.purposes.chat'));
}

console.log('\n=== 供应商标识建议列表（内部自洽性） ===');
{
    // ⚠️ 这一组**不是**防漂移守卫，别把它当守卫看。
    // 本文件是纯 Node、看不到插件的 media_presets.ts，只能检查生成器**自己**的表是否自洽
    // （建议列表覆盖各来源、无重复、都有标签）。
    // 曾经这里写着"防漂移守卫"，实际是拿 templates.js 的 MEDIA_VENDORS 比 templates.js 的
    // KNOWN_VENDORS —— 自引用、恒真。真正的守卫在跨仓库联测 §G（那边能同时 import 两边）。
    const have = new Set(KNOWN_VENDORS.map(v => v.value));
    const missMedia = MEDIA_VENDORS.filter(v => !have.has(v));
    check('建议列表覆盖 MEDIA_VENDORS', missMedia.length === 0, missMedia.join(', '));
    const missTpl = PROVIDER_TEMPLATES.map(t => t.provider).filter(v => v && !have.has(v));
    check('建议列表覆盖全部聊天模板的 vendor', missTpl.length === 0, missTpl.join(', '));
    check('建议列表无重复', new Set(KNOWN_VENDORS.map(v => v.value)).size === KNOWN_VENDORS.length);
    check('每个建议都有可读标签', KNOWN_VENDORS.every(v => v.label && v.label !== v.value));
    // 这几个是"只做媒体"的 vendor，早期纯下拉遗漏过，单独钉住
    for (const v of ['google-cloud', 'minimax', 'fishaudio', 'elevenlabs', 'baidu', 'volcengine', 'tencent-tokenhub', 'stability', 'dashscope']) {
        check(`建议列表含媒体专用 vendor ${v}`, have.has(v));
    }
    // 用途支持矩阵的自洽性（与插件的一致性由联测 §G3 守卫）
    check('支持矩阵覆盖 MEDIA_VENDORS 全部 vendor',
        MEDIA_VENDORS.every(v => Array.isArray(MEDIA_VENDOR_USES[v]) && MEDIA_VENDOR_USES[v].length > 0),
        MEDIA_VENDORS.filter(v => !MEDIA_VENDOR_USES[v]).join(', '));
    check('支持矩阵的用途取值只有 tts / image-generation',
        Object.values(MEDIA_VENDOR_USES).every(us => us.every(u => u === 'tts' || u === 'image-generation')));
    check('支持矩阵没有多余键',
        Object.keys(MEDIA_VENDOR_USES).every(v => MEDIA_VENDORS.includes(v)),
        Object.keys(MEDIA_VENDOR_USES).filter(v => !MEDIA_VENDORS.includes(v)).join(', '));
}

console.log('\n=== validateConfig：完整配置校验（与插件同口径） ===');
{
    const base = (over = {}) => ({
        version: 5,
        providers: [{
            api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-x',
            models: [{ id: 'm1', name: 'deepseek-chat', kind: 'text' }],
        }],
        purposes: { chat: 'm1' },
        ...over,
    });
    const paths = (cfg) => validateConfig(cfg).map(i => i.path);

    check('合法配置无问题', validateConfig(base()).length === 0, JSON.stringify(validateConfig(base())));
    // 这两条是联测发现的差异：UI 校验看不到 version，必须由 validateConfig 覆盖
    check('version 不为 5 被拒', paths(base({ version: 4 })).includes('$.version'));
    check('缺 version 被拒', paths(base({ version: undefined })).includes('$.version'));
    // groups 的校验已删除：字段不再受支持（导入时会丢弃并警告），不要在这里误报
    check('groups 不再参与校验（未知键不报错）',
        validateConfig(base({ groups: [{ purposes: [] }] })).length === 0,
        JSON.stringify(validateConfig(base({ groups: {} }))));
    check('非对象配置被拒', validateConfig(null).some(i => i.path === '$'));

    // UI 校验应等价于"对 UI 状态构成的配置"做完整校验
    const providers = base().providers;
    const purposes = base().purposes;
    check('validate 与 validateConfig 对 UI 状态同口径',
        validate(providers, purposes).length === validateConfig({ version: 5, providers, purposes }).length);
    check('UI 校验恒视为 version=5（不会误报版本）',
        validate(providers, purposes).length === 0);
}

console.log('\n=== 供应商自报能力位 → kind（方案 9.3.3） ===');
{
    // 这一组是本轮修复的核心：DeepSeek 的 /models 直接返回 input_modalities，
    // 不读它就会把多模态模型按名字猜成 text，而**错误的 kind 会写进配置、
    // 反向覆盖插件自己拉到的能力位**（catalog.ts:110 manual 绝对优先）。
    const ds = {
        id: 'deepseek-flash', name: 'DeepSeek Flash',
        input_modalities: ['text', 'image'], context_window: 128000,
    };
    check('DeepSeek 视觉模型 → kind=vision', kindFromMetadata(ds) === 'vision', String(kindFromMetadata(ds)));
    check('显式纯文本不产出 kind（不误报 text）',
        kindFromMetadata({ id: 'x', input_modalities: ['text'] }) === undefined);
    check('无元数据 → undefined', kindFromMetadata({ id: 'x' }) === undefined);
    check('字符串项 → undefined', kindFromMetadata('x') === undefined);

    check('architecture.input_modalities → vision',
        kindFromMetadata({ id: 'x', architecture: { input_modalities: ['text', 'image'] } }) === 'vision');
    check('output_modalities 含 image → gen',
        kindFromMetadata({ id: 'x', output_modalities: ['image'] }) === 'gen');
    check('output_modalities 含 audio → tts',
        kindFromMetadata({ id: 'x', output_modalities: ['audio'] }) === 'tts');
    check('type=embedding → embed', kindFromMetadata({ id: 'x', type: 'embedding' }) === 'embed');
    check('capabilities 数组含 vision → vision',
        kindFromMetadata({ id: 'x', capabilities: ['completion', 'vision'] }) === 'vision');
    check('capabilities 对象 vision:true → vision',
        kindFromMetadata({ id: 'x', capabilities: { vision: true } }) === 'vision');
    check('supports_vision → vision', kindFromMetadata({ id: 'x', supports_vision: true }) === 'vision');
    check('模态大小写/空格容错',
        kindFromMetadata({ id: 'x', input_modalities: [' IMAGE '] }) === 'vision');

    check('decideKind：用户手选最高优先',
        decideKind({ explicit: 'gen', meta: 'vision', name: 'deepseek-flash' }) === 'gen');
    check('decideKind：自报次之',
        decideKind({ meta: 'vision', name: 'deepseek-flash' }) === 'vision');
    check('decideKind：名字命中终值白名单',
        decideKind({ name: 'black-forest-labs/FLUX.1-schnell' }) === 'gen');
    check('decideKind：都不确定 → undefined（不写 kind，别猜 text）',
        decideKind({ name: 'deepseek-flash' }) === undefined, String(decideKind({ name: 'deepseek-flash' })));
    check('decideKind：显式空串不当作"用户选了空"',
        decideKind({ explicit: '', meta: 'vision' }) === 'vision');
}

console.log('\n=== build() 省略未定的 kind ===');
{
    const cfg = build([goodProvider({
        models: [
            { id: 'flash', name: 'deepseek-flash' },
            { id: 'flux', name: 'flux-1', kind: 'gen' },
        ],
    })], {});
    check('未定 kind 的模型不带 kind 字段', !('kind' in cfg.providers[0].models[0]),
        JSON.stringify(cfg.providers[0].models[0]));
    check('已定 kind 的模型带 kind 字段', cfg.providers[0].models[1].kind === 'gen');
    check('省略 kind 的配置仍合法（kind 是可选的）', validateConfig(cfg).length === 0,
        JSON.stringify(validateConfig(cfg)));
}
console.log('\n=== 逐模型 request 覆盖（build 原样透传，含 bodyByUse） ===');
{
    const req = { body: { model: '{model}', prompt: '{prompt}' }, response: { data_path: 'data.0.url' } };
    const cfg = build([goodProvider({
        models: [
            { id: 'g1', name: 'qwen-image-3.0-pro', kind: 'gen', request: req, bodyMode: 'replace' },
            { id: 't1', name: 'deepseek-chat', kind: 'text',
              request: { bodyByUse: { judge: { temperature: 0, max_tokens: 300 } } } },
            { id: 't2', name: 'deepseek-chat-2', kind: 'text' },
        ],
    })], { 'image-generation': 'g1', judge: 't1' });
    const m0 = cfg.providers[0].models[0];
    const m1 = cfg.providers[0].models[1];
    const m2 = cfg.providers[0].models[2];
    check('request 原样透传', JSON.stringify(m0.request) === JSON.stringify(req),
        JSON.stringify(m0.request));
    check('bodyMode 透传', m0.bodyMode === 'replace', String(m0.bodyMode));
    check('bodyByUse 逐字节保留',
        JSON.stringify(m1.request.bodyByUse) === '{"judge":{"temperature":0,"max_tokens":300}}',
        JSON.stringify(m1.request.bodyByUse));
    check('没有覆盖的模型不带 request/bodyMode',
        !('request' in m2) && !('bodyMode' in m2), JSON.stringify(m2));
    check('带 request/bodyByUse 的配置仍合法', validateConfig(cfg).length === 0, JSON.stringify(validateConfig(cfg)));
    check('build 不额外输出 groups', cfg.groups === undefined, JSON.stringify(cfg.groups));

    const cfg2 = build([goodProvider({ models: [{ id: 'a', name: 'x', request: {} }] })], {});
    check('空 request 不写进配置', !('request' in cfg2.providers[0].models[0]),
        JSON.stringify(cfg2.providers[0].models[0]));

    // 默认（0 条用途请求体）：不带 bodyByUse，整个 request 都不出现
    const cfg3 = build([goodProvider({ models: [{ id: 'a', name: 'x', kind: 'text' }] })], { chat: 'a' });
    check('默认 0 条用途请求体 → 不写 request',
        !('request' in cfg3.providers[0].models[0]), JSON.stringify(cfg3.providers[0].models[0]));
}

console.log('\n=== 导入：parseImport（build 的逆） ===');
{
    const provs = [goodProvider({
        displayName: '主连接', timeout: 30, request: { list_url: 'https://x/models' },
        models: [
            { id: 'flash', name: 'deepseek-v4-flash',
              request: { bodyByUse: { chat: { max_tokens: 65536, temperature: 1 }, summarization: { max_tokens: 300 } } } },
            { id: 'flux', name: 'flux-1', kind: 'gen', contextWindow: 128000, maxTokens: 4096,
              request: { body: { model: '{model}', prompt: '{prompt}' }, response: { data_path: 'd.0.url' } },
              bodyMode: 'replace' },
        ],
    })];
    const purposes = { chat: 'flash', 'image-generation': 'flux' };

    const cfg = build(provs, purposes);
    const res = parseImport(serialize(cfg));
    check('导入成功', res.ok, JSON.stringify(res.issues));
    check('无警告（配置里没有 groups）', res.warnings.length === 0, JSON.stringify(res.warnings));

    // 往返必须逐字节一致
    const again = build(res.state.providers, res.state.purposes);
    check('往返逐字节一致', JSON.stringify(again) === JSON.stringify(cfg),
        `\n    cfg1=${JSON.stringify(cfg)}\n    cfg2=${JSON.stringify(again)}`);

    // 字段级抽查
    const p0 = res.state.providers[0];
    check('displayName 保留', p0.displayName === '主连接', p0.displayName);
    check('timeout 保留', p0.timeout === 30, String(p0.timeout));
    check('连接级 request 保留', JSON.stringify(p0.request) === '{"list_url":"https://x/models"}',
        JSON.stringify(p0.request));
    check('模型 contextWindow/maxTokens 保留',
        p0.models[1].contextWindow === 128000 && p0.models[1].maxTokens === 4096,
        JSON.stringify(p0.models[1]));
    check('逐模型 request 原样保留（含 bodyByUse）',
        p0.models[0].request && JSON.stringify(p0.models[0].request) === JSON.stringify(provs[0].models[0].request),
        JSON.stringify(p0.models[0].request));
    check('逐模型 request/bodyMode 保留',
        p0.models[1].bodyMode === 'replace' && !!p0.models[1].request,
        JSON.stringify(p0.models[1]));
    check('未声明 kind 的模型不带 kind', !('kind' in p0.models[0]), JSON.stringify(p0.models[0]));
    check('state 只含 providers / purposes',
        JSON.stringify(Object.keys(res.state).sort()) === '["providers","purposes"]',
        JSON.stringify(Object.keys(res.state)));
    check('provider 留空保持留空', p0.provider === '', JSON.stringify(p0.provider));
    check('enabled 默认 true', p0.enabled === true);
}

console.log('\n=== 导入：拒绝非法内容（不能改坏现有配置） ===');
{
    const bad = [
        ['空串', ''],
        ['只有空白', '   '],
        ['非 JSON', 'not json at all'],
        ['JSON 语法错', '{"version":5,'],
        ['数组', '[1,2,3]'],
        ['版本不对', '{"version":4,"providers":[{"api":"openai-completions","baseURL":"https://a.com/v1","apiKey":"k"}]}'],
        ['缺 providers', '{"version":5,"providers":[]}'],
        ['api 非法', '{"version":5,"providers":[{"api":"grpc","baseURL":"https://a.com/v1","apiKey":"k"}]}'],
        ['缺 baseURL', '{"version":5,"providers":[{"api":"openai-completions","apiKey":"k"}]}'],
        ['缺 apiKey', '{"version":5,"providers":[{"api":"openai-completions","baseURL":"https://a.com/v1"}]}'],
        ['模型 id 重复', '{"version":5,"providers":[{"api":"openai-completions","baseURL":"https://a.com/v1","apiKey":"k","models":[{"id":"x","name":"a"}]},{"api":"openai-completions","baseURL":"https://b.com/v1","apiKey":"k","models":[{"id":"x","name":"b"}]}]}'],
        ['purposes 悬空', '{"version":5,"providers":[{"api":"openai-completions","baseURL":"https://a.com/v1","apiKey":"k","models":[{"id":"m","name":"a"}]}],"purposes":{"chat":"ghost"}}'],
        ['用途×类型不匹配', '{"version":5,"providers":[{"api":"openai-completions","baseURL":"https://a.com/v1","apiKey":"k","models":[{"id":"m","name":"a","kind":"text"}]}],"purposes":{"image-generation":"m"}}'],
    ];
    for (const [name, text] of bad) {
        const r = parseImport(text);
        check(`拒绝：${name}`, r.ok === false && r.issues.length > 0,
            `ok=${r.ok} issues=${JSON.stringify(r.issues)}`);
        check(`  拒绝时不给 state（不会改动配置）：${name}`, r.state === undefined);
    }
}

console.log('\n=== 导入：旧配置的 groups 已停用 → 丢弃 + 明确警告 ===');
{
    // 插件侧删掉了用途组机制，请求体覆盖改走 models[].request.bodyByUse。
    // 旧导出/手写配置里的 groups 不能把整份导入弄失败，但也不能静默吞掉 —— 丢弃 + 警告。
    const text = JSON.stringify({
        version: 5,
        providers: [{
            api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKey: 'k',
            models: [{ id: 'm', name: 'deepseek-chat' }],
        }],
        purposes: { chat: 'm' },
        groups: [{ purposes: ['chat'], body: { max_tokens: 7 } }],
        // 旧 UI 草稿键（不是 v5 配置字段）：一并忽略，不该让导入失败
        useBodies: { chat: { max_tokens: 7 } },
        judgePreset: true,
    });
    const r = parseImport(text);
    check('仍导入成功', r.ok, JSON.stringify(r.issues));
    check('有警告（用途组请求体已停用）',
        r.warnings.some(w => /用途组请求体/.test(w) && /已停用/.test(w)), JSON.stringify(r.warnings));
    check('state 只含 providers / purposes（不含 groups/useBodies/judgePreset）',
        JSON.stringify(Object.keys(r.state).sort()) === '["providers","purposes"]',
        JSON.stringify(Object.keys(r.state)));
    const out = build(r.state.providers, r.state.purposes);
    check('导出不再包含 groups', out.groups === undefined, JSON.stringify(out.groups));
    check('导出仍合法', validateConfig(out).length === 0, JSON.stringify(validateConfig(out)));

    // 往返稳定：导出的配置里没有 groups，再导入不会再报该警告
    const r2 = parseImport(serialize(out));
    check('二次导入不再有用途组警告',
        r2.ok && !r2.warnings.some(w => /用途组请求体/.test(w)), JSON.stringify(r2.warnings));
}

console.log('\n=== 导入：旧配置里的 compression 用途被清洗 + 警告 ===');
{
    // 插件侧已彻底移除 compression（ChatModelUse / schema / 出厂配置都没有了）。
    // 旧导出/手写配置里还带着它 —— 不能因此让整份导入失败，必须先清洗再校验。
    const mkLegacy = () => ({
        version: 5,
        providers: [{
            api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKey: 'k',
            models: [{ id: 'm', name: 'deepseek-chat' }],
        }],
        purposes: { chat: 'm', compression: 'm' },
        groups: [
            { purposes: ['chat', 'compression', 'summarization', 'judge'], body: { max_tokens: 5 } },
            { purposes: ['compression'], body: { max_tokens: 9 } },
        ],
    });

    // 前提：不清理时这份旧配置**就是非法的** —— 这正是"先清洗再校验"的原因
    check('未清理的旧配置会被判非法（未知用途 compression）',
        validateConfig(mkLegacy()).some(p => /compression/.test(p.path + p.msg)),
        JSON.stringify(validateConfig(mkLegacy())));

    const r = parseImport(JSON.stringify(mkLegacy()));
    check('含 compression 的旧配置导入成功', r.ok, JSON.stringify(r.issues));
    check('  给出明确警告', r.warnings.some(w => /压缩/.test(w)), JSON.stringify(r.warnings));
    check('  用途绑定里 compression 已剔除', !('compression' in r.state.purposes),
        JSON.stringify(r.state.purposes));
    check('  旧 groups 也丢弃并警告', r.warnings.some(w => /用途组请求体/.test(w)), JSON.stringify(r.warnings));

    // 再导出：配置合法、彻底不再出现 compression 与 groups
    const out = build(r.state.providers, r.state.purposes);
    check('  导出后配置合法', validateConfig(out).length === 0, JSON.stringify(validateConfig(out)));
    check('  导出后不再出现 compression', !serialize(out).includes('compression'), serialize(out));
    check('  导出后没有 groups', out.groups === undefined, JSON.stringify(out.groups));

    // 极端情况：只绑了 compression（别的用途都没有）→ 清洗后成了空绑定，也不能报错
    const only = mkLegacy();
    delete only.purposes.chat;
    const r2 = parseImport(JSON.stringify(only));
    check('只绑了 compression 的旧配置也能导入', r2.ok, JSON.stringify(r2.issues));
    check('  清洗后没有任何用途绑定', Object.keys(r2.state.purposes).length === 0,
        JSON.stringify(r2.state.purposes));
}

console.log('\n=== vendorByEndpointPath：host 认不出时按路径反查 ===');
{
    // 必须与插件 vendor.ts 的 vendorByUrlSuffix 同规则（跨仓库联测 §M 逐条比对）
    const MAAS = 'https://llm-w67ttc0b3gqiltm8.cn-beijing.maas.aliyuncs.com'
        + '/api/v1/services/aigc/multimodal-generation/generation';

    check('百炼原生完整端点 → dashscope', vendorByEndpointPath(MAAS) === 'dashscope', vendorByEndpointPath(MAAS));
    check('query 串不影响判定', vendorByEndpointPath(MAAS + '?a=1') === 'dashscope');
    check('hash 不影响判定', vendorByEndpointPath(MAAS + '#f') === 'dashscope');
    check('尾斜杠不影响判定', vendorByEndpointPath(MAAS + '/') === 'dashscope');
    check('stability → stability',
        vendorByEndpointPath('https://x/v2beta/stable-image/generate/ultra') === 'stability');
    check('google-cloud → google-cloud',
        vendorByEndpointPath('https://x/v1beta1/text:synthesize') === 'google-cloud');
    check('minimax → minimax', vendorByEndpointPath('https://x/t2a_v2') === 'minimax');

    // 反例：**共用**路径绝不能被用来反查（否则自建网关会被误判成某一家）
    check('自建网关 /v1 → 空', vendorByEndpointPath('https://my.host/v1') === '');
    check('共用 /images/generations → 空', vendorByEndpointPath('https://my.host/images/generations') === '');
    check('共用 /audio/speech → 空', vendorByEndpointPath('https://my.host/audio/speech') === '');
    check('空串 → 空', vendorByEndpointPath('') === '');

    // resolveVendorFromUrl 应包含这条兜底（host 优先，路径次之）
    check('resolveVendorFromUrl 也认完整端点', resolveVendorFromUrl(MAAS) === 'dashscope',
        resolveVendorFromUrl(MAAS));
    check('host 命中时仍优先 host（不被路径覆盖）',
        resolveVendorFromUrl('https://dashscope.aliyuncs.com/compatible-mode/v1') === 'alibaba',
        resolveVendorFromUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'));

    // 路径表本身的自洽性（与插件的一致性由联测 §M 守卫）
    check('路径表非空且每条都带 vendor',
        MEDIA_ENDPOINT_SUFFIXES.length > 0 && MEDIA_ENDPOINT_SUFFIXES.every(([s, v]) => s && v));
    check('路径表不含共用路径',
        !MEDIA_ENDPOINT_SUFFIXES.some(([s]) => s === '/images/generations' || s === '/audio/speech'));
}

console.log('\n=== 导入时补上缺失的 provider（仅当路径能认出） ===');
{
    const MAAS = 'https://llm-w67ttc0b3gqiltm8.cn-beijing.maas.aliyuncs.com'
        + '/api/v1/services/aigc/multimodal-generation/generation';
    const mk = (baseURL) => JSON.stringify({
        version: 5,
        providers: [{ api: 'openai-completions', baseURL, apiKey: 'k',
            models: [{ id: 'm', name: 'qwen-image-3.0-pro', kind: 'gen' }] }],
        purposes: { 'image-generation': 'm' },
    });

    const r = parseImport(mk(MAAS));
    check('完整端点导入成功', r.ok, JSON.stringify(r.issues));
    check('  按路径补上 provider=dashscope', r.state.providers[0].provider === 'dashscope',
        JSON.stringify(r.state.providers[0].provider));
    check('  有明确警告（不静默改数据）', r.warnings.some(w => /补上 provider/.test(w)),
        JSON.stringify(r.warnings));
    const out = build(r.state.providers, r.state.purposes);
    check('  导出后配置里确实有 provider', out.providers[0].provider === 'dashscope',
        JSON.stringify(out.providers[0].provider));
    check('  补完后配置仍合法', validateConfig(out).length === 0, JSON.stringify(validateConfig(out)));

    // 反例：普通网关**不该**被补 provider（host 认不出、路径也认不出 → 保持留空走自动识别）
    const r2 = parseImport(mk('https://my.host/v1'));
    check('普通网关不补 provider（保持留空）', r2.state.providers[0].provider === '',
        JSON.stringify(r2.state.providers[0].provider));
    check('  也不产生该警告', !r2.warnings.some(w => /补上 provider/.test(w)),
        JSON.stringify(r2.warnings));

    // 反例：已有 provider 时不覆盖
    const withProvider = JSON.stringify({
        version: 5,
        providers: [{ api: 'openai-completions', baseURL: MAAS, apiKey: 'k', provider: 'alibaba',
            models: [{ id: 'm', name: 'x', kind: 'gen' }] }],
        purposes: { 'image-generation': 'm' },
    });
    const r3 = parseImport(withProvider);
    check('已有 provider 时不被覆盖', r3.state.providers[0].provider === 'alibaba',
        JSON.stringify(r3.state.providers[0].provider));
}
console.log('\n=== providerForTemplate：什么时候必须把 provider 写进配置 ===');
{
    // 默认留空走自动识别；只有"地址反查不回自己"的模板才必须写。
    //
    // **现在没有任何模板属于那一类**：曾经有「百炼原生」（与阿里百炼共用 host、
    // 反查必然得 alibaba，所以必须显式写 dashscope），但它已随兼容层一并删除 ——
    // 插件侧现在按模型名分流（qwen-image 走兼容、wanx 与 TTS 走主机根原生端点），
    // "选兼容还是选原生"不该让用户决定。
    //
    // dashscope 作为**逃生舱**保留（供应商标识可手填），应对"只暴露原生接口"的部署。
    const ali = PROVIDER_TEMPLATES.find(t => t.id === 'alibaba');
    const deep = PROVIDER_TEMPLATES.find(t => t.id === 'deepseek');

    check('「百炼原生」模板已删除', !PROVIDER_TEMPLATES.some(t => t.id === 'dashscope'),
        JSON.stringify(PROVIDER_TEMPLATES.map(t => t.id)));
    check('阿里百炼：地址能反查回自己 → 留空（不写冗余字段）',
        providerForTemplate(ali) === '', providerForTemplate(ali));
    check('DeepSeek：留空', providerForTemplate(deep) === '', providerForTemplate(deep));
    check('所有模板都不需要显式写 provider（兼容层已接管）',
        PROVIDER_TEMPLATES.every(t => providerForTemplate(t) === ''),
        JSON.stringify(PROVIDER_TEMPLATES.filter(t => providerForTemplate(t) !== '').map(t => t.id)));
    check('自定义模板（无 provider）：留空', providerForTemplate({ provider: '', baseUrl: '' }) === '');
    check('空模板不炸', providerForTemplate(null) === '' && providerForTemplate(undefined) === '');

    // 不变式：写了 provider 的，一定是因为反查不回来
    for (const t of PROVIDER_TEMPLATES) {
        const p = providerForTemplate(t);
        if (p) {
            check(`  ${t.id} 写了 provider，确实因为反查不回来`,
                resolveVendorFromUrl(t.baseUrl) !== t.provider,
                `反查得 ${resolveVendorFromUrl(t.baseUrl)}`);
        }
    }
    // 反过来：凡是反查不回自己的模板，都必须写（否则插件会选错预设）
    for (const t of PROVIDER_TEMPLATES) {
        if (t.provider && resolveVendorFromUrl(t.baseUrl) !== t.provider) {
            check(`  ${t.id} 反查不回自己，已写 provider`, providerForTemplate(t) === t.provider);
        }
    }
}
console.log('\n=== 模板数据 ===');
{
    check('模板数量 12（「百炼原生」已删，新增 Jev 决策）', PROVIDER_TEMPLATES.length === 12, String(PROVIDER_TEMPLATES.length));
    check('google 的 provider 是 google', PROVIDER_TEMPLATES.find(t => t.id === 'google').provider === 'google');
    check('anthropic 用 anthropic-messages 协议',
        PROVIDER_TEMPLATES.find(t => t.id === 'anthropic').api === 'anthropic-messages');
    check('除 anthropic 外都是 openai-completions',
        PROVIDER_TEMPLATES.filter(t => t.id !== 'anthropic' && t.id !== 'custom')
            .every(t => t.api === 'openai-completions'));
    const nonCustom = PROVIDER_TEMPLATES.filter(t => t.id !== 'custom');
    check('除 custom 外都有默认 baseUrl', nonCustom.every(t => /^https:\/\//.test(t.baseUrl)));
    check('每个模板都有 cors 标注', PROVIDER_TEMPLATES.every(t => !!t.cors));
    check('api 枚举与协议表一致', PROVIDER_TEMPLATES.every(t => API_DIALECTS.some(a => a.value === t.api)));
    check('7 个用途', PURPOSES.length === 7, String(PURPOSES.length));
    check('6 种 kind（含 decision）', KIND_VALUES.length === 6 && KIND_VALUES.includes('decision'), KIND_VALUES.join(','));
    const ids = PROVIDER_TEMPLATES.map(t => t.id);
    check('模板 id 无重复', new Set(ids).size === ids.length);
}

console.log('\n=== 拉取错误的分类文案（方案 9.3.2） ===');
{
    const kinds = ['cors', 'auth', 'notfound', 'network', 'timeout', 'empty'];
    check('FetchError 带 kind 字段', new FetchError('cors', 'x').kind === 'cors');
    check('FetchError 是 Error 子类', new FetchError('auth', 'x') instanceof Error);
    check('kind 取值集合固定', kinds.length === 6);
}

console.log('\n=== 用途表守卫（§12.4）：键与顺序固定，judge = 评分 ===');
{
    // 插件侧已有同样的守卫（scripts/integration-config-generator.mjs §G7：
    // isDeepStrictEqual(PURPOSES.map(p=>p.key), MODEL_USES)）。生成器这边也钉死一份：
    // 联测不可用时（CI 没有 sibling 仓库）也能挡住"本地手滑改键/换序"。
    const EXPECTED_PURPOSE_KEYS = [
        'chat', 'summarization', 'judge',
        'image-understanding', 'text-embedding', 'tts', 'image-generation',
    ];
    check('PURPOSES 键顺序 = 固定 7 键预期（含顺序）',
        JSON.stringify(PURPOSES.map(p => p.key)) === JSON.stringify(EXPECTED_PURPOSE_KEYS),
        JSON.stringify(PURPOSES.map(p => p.key)));
    check('没有新增 decision / compression 之类用途（插件对未知用途整份拒绝）',
        PURPOSES.length === 7 && !PURPOSES.some(p => ['decision', 'compression'].includes(p.key)),
        JSON.stringify(PURPOSES.map(p => p.key)));
    const judge = PURPOSES.find(p => p.key === 'judge');
    check('judge 标签 =「评分」', judge.label === '评分', judge.label);
    check('judge hint 是评分用途说明', /评分/.test(judge.hint), judge.hint);
    check('judge hint 提到文本/视觉/决策模型', /文本/.test(judge.hint) && /decision/.test(judge.hint), judge.hint);
    check('judge 不再叫「评分 / 决策（判定）」', !/决策/.test(judge.label) && !/判定/.test(judge.label), judge.label);
    check('每个用途都有 label/hint', PURPOSES.every(p => !!p.label && !!p.hint));
}

console.log('\n=== 评分模型选型提示 PURPOSE_MODEL_HINTS（§12.2：结构化、只提示不预选） ===');
{
    const hint = PURPOSE_MODEL_HINTS.judge;
    check('存在 judge 提示', !!hint);
    check('提示的键都是合法用途（不新增 purpose）',
        Object.keys(PURPOSE_MODEL_HINTS).every(k => PURPOSES.some(p => p.key === k)),
        JSON.stringify(Object.keys(PURPOSE_MODEL_HINTS)));
    check('没有 decision 提示键', !('decision' in PURPOSE_MODEL_HINTS));
    check('带 title / summary / disclaimer', !!hint.title && !!hint.summary && !!hint.disclaimer);
    check('标题是评分用途选型提示（不再叫判定/决策）',
        /评分/.test(hint.title) && !/判定|决策/.test(hint.title), hint.title);
    check('说明提到可绑多个互相替换的模型',
        /多个/.test(hint.summary) && /替换|替补/.test(hint.summary), hint.summary.slice(0, 120));
    check('priceTierLabels 覆盖 low/mid/high',
        ['low', 'mid', 'high'].every(k => !!hint.priceTierLabels[k]));
    check('capabilityLabels 覆盖 yes/no/verify',
        ['yes', 'no', 'verify'].every(k => !!hint.capabilityLabels[k]));

    const vendors = Array.isArray(hint.vendors) ? hint.vendors : [];
    check('vendor 评分候选非空', vendors.length > 0, String(vendors.length));
    const badShape = [];
    const badTier = [];
    const badCap = [];
    const badNames = [];
    const knownVendors = new Set(KNOWN_VENDORS.map(v => v.value));
    const badVendors = [];
    for (const v of vendors) {
        if (typeof v.vendor !== 'string' || typeof v.label !== 'string' || !Array.isArray(v.candidates)
            || v.candidates.length === 0 || !v.candidates.every(c => typeof c === 'string' && c.trim())) {
            badShape.push(v.vendor);
        }
        if (!['low', 'mid', 'high'].includes(v.priceTier)) badTier.push(`${v.vendor}=${v.priceTier}`);
        if (!['yes', 'no', 'verify'].includes(v.structuredOutput)) badCap.push(`${v.vendor}.structuredOutput=${v.structuredOutput}`);
        if (!['yes', 'no', 'verify'].includes(v.thinking)) badCap.push(`${v.vendor}.thinking=${v.thinking}`);
        if (!knownVendors.has(v.vendor)) badVendors.push(v.vendor);
        if (typeof v.note !== 'string' || !v.note.trim()) badNames.push(v.vendor);
    }
    check('每条都有 vendor / label / candidates[]', badShape.length === 0, badShape.join(', '));
    check('价格档取值合法（low/mid/high）', badTier.length === 0, badTier.join(', '));
    check('structuredOutput / thinking 取值合法（yes/no/verify）', badCap.length === 0, badCap.join(', '));
    check('vendor 都来自 KNOWN_VENDORS（拼错只影响提示，仍要拦住）', badVendors.length === 0, badVendors.join(', '));
    check('每条都有 note', badNames.length === 0, badNames.join(', '));
    // 只提示不预选：这份数据不在 v5.js 的构建路径里（构建输出与它无关）。
    const provs = [goodProvider({ models: [{ id: 'm1', name: 'deepseek-flash', kind: 'text' }] })];
    check('提示数据不进入生成配置', !serialize(build(provs, { judge: 'm1' })).includes('PURPOSE_MODEL_HINTS'));
}

console.log('\n=== build() 输出结构：不再有 groups（用途组请求体已随插件移除） ===');
{
    // 基线 = **移除 groups 之后** build 的逐字节输出。只要键序 / 字段有漂移，这里立刻失败。
    // （旧基线里的 groups 由 build 派生；那套机制已随插件删除，见 docs/13 的后续修订。）
    const BASELINE = '{"version":5,"providers":[{"api":"openai-completions","baseURL":"https://api.deepseek.com/v1","apiKey":"sk-a","models":[{"id":"flash","name":"deepseek-flash","kind":"vision"},{"id":"pro","name":"deepseek-pro","kind":"text"}]}],"purposes":{"chat":["flash"],"summarization":["flash"],"judge":["pro"],"image-understanding":["flash"]}}';
    const provs = [{
        id: 'c1', templateId: 'deepseek', mode: 'vendor', provider: '', api: 'openai-completions',
        baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-a',
        models: [
            { id: 'flash', name: 'deepseek-flash', kind: 'vision' },
            { id: 'pro', name: 'deepseek-pro', kind: 'text' },
        ],
        enabled: true, displayName: '', timeout: 0, request: {},
    }];
    const purposes = { chat: ['flash'], summarization: ['flash'], judge: ['pro'], 'image-understanding': ['flash'] };

    const out = build(provs, purposes);
    check('逐字节等于新基线', serialize(out) === BASELINE, serialize(out));
    check('输出不含 groups', out.groups === undefined, JSON.stringify(out.groups));
    check('输出不含 useBodies / judgePreset',
        !('useBodies' in out) && !('judgePreset' in out), JSON.stringify(Object.keys(out)));
    check('输出键只有 version / providers / purposes',
        JSON.stringify(Object.keys(out)) === '["version","providers","purposes"]', JSON.stringify(Object.keys(out)));
    // 旧调用方可能还按旧签名多传参数 build(providers, purposes, useBodies, extraGroups, options)：
    // 直接忽略，**不会**凭空产出 groups。
    const legacyCall = build(provs, purposes, { chat: { max_tokens: 1 } }, [{ purposes: ['chat'] }], { judgePreset: true });
    check('旧参数被忽略（不产 groups、输出不变）', serialize(legacyCall) === BASELINE, serialize(legacyCall));
    check('不出现 response_format（判定预设 body 已删除）', !serialize(out).includes('response_format'));
}

console.log('\n=== 逐模型「用途请求体」：kind 过滤 + bodyByUse 校验 ===');
{
    // UI 用 bodyUsePurposesForKind 决定某模型类型下能加哪些用途（与插件 isEligible 同规则）
    const keys = (kind) => bodyUsePurposesForKind(kind).map(p => p.key);
    check('text → chat / summarization / judge',
        JSON.stringify(keys('text')) === '["chat","summarization","judge"]', JSON.stringify(keys('text')));
    check('kind 缺省按 text 处理', JSON.stringify(keys(undefined)) === JSON.stringify(keys('text')));
    check('vision → 再加 image-understanding',
        JSON.stringify(keys('vision')) === '["chat","summarization","judge","image-understanding"]',
        JSON.stringify(keys('vision')));
    for (const k of ['embed', 'gen', 'tts']) {
        check(`${k} 不提供入口（空数组）`, keys(k).length === 0, JSON.stringify(keys(k)));
    }
    check('返回的用途都在 PURPOSES 里',
        bodyUsePurposesForKind('vision').every(p => PURPOSES.some(x => x.key === p.key)));

    const base = (over = {}) => ({
        version: 5,
        providers: [{
            api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-x',
            models: [{ id: 'm1', name: 'deepseek-chat', kind: 'text', ...over }],
        }],
        purposes: { chat: 'm1' },
    });
    const paths = (cfg) => validateConfig(cfg).map(i => i.path);

    check('合法 bodyByUse 通过',
        validateConfig(base({ request: { bodyByUse: { chat: { max_tokens: 65536, temperature: 1 } } } })).length === 0,
        JSON.stringify(validateConfig(base({ request: { bodyByUse: { chat: { max_tokens: 1 } } } }))));
    check('未知用途被拒',
        paths(base({ request: { bodyByUse: { bogus: { max_tokens: 1 } } } }))
            .includes('$.providers[0].models[0].request.bodyByUse.bogus'),
        JSON.stringify(paths(base({ request: { bodyByUse: { bogus: {} } } }))));
    check('bodyByUse 非对象被拒',
        paths(base({ request: { bodyByUse: [] } })).includes('$.providers[0].models[0].request.bodyByUse'));
    check('请求体值非对象被拒',
        paths(base({ request: { bodyByUse: { chat: 5 } } })).includes('$.providers[0].models[0].request.bodyByUse.chat'));
    check('thinking 是字符串被拒（插件同口径）',
        paths(base({ request: { bodyByUse: { chat: { thinking: 'disabled' } } } }))
            .includes('$.providers[0].models[0].request.bodyByUse.chat.thinking'),
        JSON.stringify(paths(base({ request: { bodyByUse: { chat: { thinking: 'disabled' } } } }))));
    check('thinking：null 允许（等同于没写）',
        validateConfig(base({ request: { bodyByUse: { chat: { thinking: null } } } })).length === 0);
    check('thinking 是对象通过（厂商字段由用户自填）',
        validateConfig(base({ request: { bodyByUse: { chat: { thinking: { type: 'disabled' } } } } })).length === 0,
        JSON.stringify(validateConfig(base({ request: { bodyByUse: { chat: { thinking: { type: 'disabled' } } } } }))));
    check('类型不匹配被拒（text 模型用 image-understanding 覆盖）',
        paths(base({ request: { bodyByUse: { 'image-understanding': { max_tokens: 1 } } } }))
            .includes('$.providers[0].models[0].request.bodyByUse.image-understanding'));
    check('request 非对象被拒',
        paths(base({ request: [] })).includes('$.providers[0].models[0].request'));
}

console.log('\n=== 逐模型「用途请求体」：导入→导出往返 + 空默认 ===');
{
    const provs = [goodProvider({
        models: [
            { id: 'flash', name: 'deepseek-flash', kind: 'vision',
              request: { bodyByUse: {
                  chat: { max_tokens: 65536, temperature: 1 },
                  judge: { temperature: 0, max_tokens: 300, response_format: { type: 'json_object' } },
                  'image-understanding': { max_tokens: 2048 },
              } } },
            { id: 'pro', name: 'deepseek-pro', kind: 'text' },
        ],
    })];
    const purposes = { chat: ['flash'], summarization: ['flash'], judge: ['flash'] };
    const cfg = build(provs, purposes);
    const text = serialize(cfg);

    const rt = parseImport(text);
    check('导入成功', rt.ok, JSON.stringify(rt.issues));
    check('导入无警告', rt.warnings.length === 0, JSON.stringify(rt.warnings));
    check('bodyByUse 原样保留',
        JSON.stringify(rt.state.providers[0].models[0].request.bodyByUse)
        === JSON.stringify(provs[0].models[0].request.bodyByUse),
        JSON.stringify(rt.state.providers[0].models[0].request));
    const again = build(rt.state.providers, rt.state.purposes);
    check('导入→导出逐字节一致', serialize(again) === text,
        `\n    前=${text}\n    后=${serialize(again)}`);
    const rt2 = parseImport(serialize(again));
    check('二次往返仍一致', serialize(build(rt2.state.providers, rt2.state.purposes)) === text);

    // 空默认：0 条用途请求体 = 不写 bodyByUse、整个 request 都不出现
    const empty = build([goodProvider({ models: [{ id: 'pro', name: 'deepseek-pro', kind: 'text' }] })], { chat: 'pro' });
    check('默认 0 条 → 模型不带 request',
        !('request' in empty.providers[0].models[0]), JSON.stringify(empty.providers[0].models[0]));
    check('空默认往返后仍不带 request',
        !('request' in parseImport(serialize(empty)).state.providers[0].models[0]));

    // 旧配置带 groups：groups 丢弃，但 models[].request 必须原样活着
    const legacy = JSON.stringify({
        version: 5,
        providers: [{
            api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKey: 'k',
            models: [{ id: 'm', name: 'deepseek-chat', kind: 'text',
                request: { bodyByUse: { chat: { max_tokens: 12 } }, body: { stop: null } } }],
        }],
        purposes: { chat: 'm' },
        groups: [{ purposes: ['chat'], body: { max_tokens: 7 } }],
    });
    const lr = parseImport(legacy);
    check('含 groups 的旧配置导入成功', lr.ok, JSON.stringify(lr.issues));
    check('  models[].request 原样保留',
        JSON.stringify(lr.state.providers[0].models[0].request)
        === '{"bodyByUse":{"chat":{"max_tokens":12}},"body":{"stop":null}}',
        JSON.stringify(lr.state.providers[0].models[0].request));
    check('  state 里没有 groups', !('groups' in lr.state));
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
