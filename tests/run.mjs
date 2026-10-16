// 自包含测试：生成器 + 解析器的纯逻辑断言（不需要浏览器、不需要插件仓库）。
// 运行：node tests/run.mjs
import { renderConn, renderExport, validateConn } from '../js/toml-gen.js';
import { parseConnection, parseExportText, TomlParseError } from '../js/toml-parse.js';
import { PROVIDER_TEMPLATES, templateIdForProvider } from '../js/templates.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`); }
}
function throwsWith(name, fn, re) {
    try { fn(); fail++; console.log(`  FAIL  ${name} :: 未抛错`); }
    catch (e) {
        const ok = re.test(e.message);
        if (ok) { pass++; console.log(`  PASS  ${name}`); }
        else { fail++; console.log(`  FAIL  ${name} :: ${e.message}`); }
    }
}

console.log('=== 生成：基本形状 ===');
{
    const t = renderConn({
        provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-a',
        models: ['deepseek-ai/DeepSeek-V3', 'black-forest-labs/FLUX.1-schnell'],
        types: { 'black-forest-labs/FLUX.1-schnell': 'gen' },
    });
    const lines = t.split('\n');
    check('api_key 在第一行', lines[0] === 'api_key = "sk-a"');
    check('provider 行存在', t.includes('provider = "siliconflow"'));
    check('models 为字符串数组', t.includes('models = ["deepseek-ai/DeepSeek-V3", "black-forest-labs/FLUX.1-schnell"]'));
    check('[types] 表存在', /^\[types\]$/m.test(t));
    check('斜杠模型名加了引号', t.includes('"black-forest-labs/FLUX.1-schnell" = "gen"'));
    check('[types] 是本框最后一个表', t.trim().split('\n').pop() === '"black-forest-labs/FLUX.1-schnell" = "gen"');
    const afterTypes = t.slice(t.indexOf('[types]')).split('\n').slice(1).join('\n');
    check('[types] 之后无顶层键', !/^\s*(api_key|provider|base_url|models|ignore)\s*=/m.test(afterTypes));
}

console.log('\n=== 生成：可选键不落空 ===');
{
    const t = renderConn({ provider: 'zhipu', baseUrl: '', apiKey: 'k', models: [] });
    check('base_url 为空时不输出该行', !t.includes('base_url'));
    check('models 为空时不输出该行（=自动拉取）', !t.includes('models'));
    check('无 types 时不输出 [types]', !t.includes('[types]'));
    check('无 types 时仍含 provider', t.includes('provider = "zhipu"'));
}

console.log('\n=== 生成：ignore 与遮蔽 ===');
{
    const t = renderConn({ provider: 'deepseek', baseUrl: '', apiKey: 'sk-real', models: ['m'], ignore: true });
    check('ignore 输出为 1', /^ignore = 1$/m.test(t));
    const m = renderConn({ provider: 'deepseek', baseUrl: '', apiKey: 'sk-real', models: ['m'] }, { maskKey: true });
    check('遮蔽模式替换 key', m.includes('api_key = "sk-xxxx"'));
    check('遮蔽模式不泄露原 key', !m.includes('sk-real'));
}

console.log('\n=== 生成：转义 ===');
{
    const t = renderConn({ provider: 'x', baseUrl: 'https://a/v1', apiKey: 'sk-"quoted"\\back', models: [] });
    check('key 中的引号被转义', t.includes('\\"quoted\\"'));
    check('key 中的反斜杠被转义', t.includes('\\\\back'));
}

console.log('\n=== 校验：必须拦住的错误 ===');
{
    check('空 api_key 报错', validateConn({ provider: 'deepseek', baseUrl: '', apiKey: '', models: [] })
        .some(e => e.includes('api_key')));
    check('provider 与 base_url 同时为空时报错',
        validateConn({ provider: '', baseUrl: '', apiKey: 'k', models: [] }).some(e => e.includes('base_url')));
    check('base_url 缺协议头报错',
        validateConn({ provider: '', baseUrl: 'api.foo.com', apiKey: 'k', models: [] }).some(e => e.includes('http')));
    check('合法连接无错误',
        validateConn({ provider: 'deepseek', baseUrl: '', apiKey: 'k', models: ['m'] }).length === 0);
    check('自定义 provider + 合法 base_url 无错误',
        validateConn({ provider: '', baseUrl: 'https://gw/v1', apiKey: 'k', models: [] }).length === 0);
}

console.log('\n=== 往返：生成 -> 解析 ===');
{
    const src = {
        provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-rt',
        models: ['a/b', 'c.d:e'], types: { 'a/b': 'gen', 'c.d:e': 'tts' },
    };
    const r = parseConnection(renderConn(src));
    check('provider 往返一致', r.fields.provider === src.provider);
    check('apiKey 往返一致', r.fields.apiKey === src.apiKey);
    check('models 往返一致', JSON.stringify(r.fields.models) === JSON.stringify(src.models));
    check('types 往返一致', JSON.stringify(r.types) === JSON.stringify(src.types));
    check('types 值未被当作嵌套表', typeof r.types['c.d:e'] === 'string');
}

console.log('\n=== 解析：错误必须带行号 ===');
{
    throwsWith('未加引号的点号键被拒绝',
        () => parseConnection('api_key = "k"\n[types]\nglm-4.5 = "vision"'), /第 3 行/);
    throwsWith('非法 tag 被拒绝',
        () => parseConnection('api_key = "k"\n[types]\n"m" = "chat"'), /第 3 行/);
    throwsWith('未知表被拒绝',
        () => parseConnection('[foo]\nx = 1'), /第 1 行/);
    throwsWith('缺收尾引号被拒绝',
        () => parseConnection('api_key = "k'), /第 1 行/);
    throwsWith('数字数组被拒绝',
        () => parseConnection('api_key = "k"\nmodels = [1,2]'), /第 2 行/);
    throwsWith('数组表被拒绝',
        () => parseConnection('[[x]]'), /第 1 行/);
}

console.log('\n=== 解析：宽容与提示 ===');
{
    const r = parseConnection('api_key = "k"\nfoo = "bar"');
    check('未知顶层键被收集而非报错', JSON.stringify(r.unknown) === '["foo"]');
    const c = parseConnection('api_key = "sk-a#b" # 真注释');
    check('字符串内的 # 不被当注释', c.fields.apiKey === 'sk-a#b', c.fields.apiKey);
    const n = parseConnection('api_key = "k"\n\n   \n# 整行注释\nprovider = "zhipu"');
    check('空行与纯注释行被跳过', n.fields.provider === 'zhipu');
    const q = parseConnection('api_key = "k"\n[types]\n"a.b/c:d" = "vision"');
    check('引号键正确解析', q.types['a.b/c:d'] === 'vision');
}

console.log('\n=== 解析：多框导出 ===');
{
    const ex = renderExport([
        { provider: 'deepseek', baseUrl: '', apiKey: 'k1', models: ['m1'] },
        { provider: 'zhipu', baseUrl: '', apiKey: 'k2', models: ['m2'] },
    ]);
    const blocks = parseExportText(ex);
    check('切出 2 个连接', blocks.length === 2, String(blocks.length));
    check('框序保持', blocks[0].fields.provider === 'deepseek' && blocks[1].fields.provider === 'zhipu');
    const single = parseExportText(renderConn({ provider: 'xai', baseUrl: '', apiKey: 'k', models: [] }));
    check('单框文本也返回 1 个连接', single.length === 1 && single[0].fields.provider === 'xai');
}

console.log('\n=== 模板数据 ===');
{
    check('模板数量为 11', PROVIDER_TEMPLATES.length === 11, String(PROVIDER_TEMPLATES.length));
    check('google 模板 provider 是 google 而非 gemini',
        PROVIDER_TEMPLATES.find(t => t.id === 'google').provider === 'google');
    check('anthropic 模板存在',
        PROVIDER_TEMPLATES.find(t => t.id === 'anthropic').provider === 'anthropic');
    check('custom 的 provider 为空',
        PROVIDER_TEMPLATES.find(t => t.id === 'custom').provider === '');
    check('按 provider 反查模板', templateIdForProvider('zhipu') === 'zhipu');
    check('未知 provider 回落 custom', templateIdForProvider('my-gateway') === 'custom');
    check('空 provider 回落 custom', templateIdForProvider('') === 'custom');
    const ids = PROVIDER_TEMPLATES.map(t => t.id);
    check('模板 id 无重复', new Set(ids).size === ids.length);
    const nonCustom = PROVIDER_TEMPLATES.filter(t => t.id !== 'custom');
    check('除 custom 外都有默认 base_url', nonCustom.every(t => /^https:\/\//.test(t.baseUrl)));
    check('除 custom 外都有 provider', nonCustom.every(t => t.provider !== ''));
    check('除 custom 外都有模型示例', nonCustom.every(t => t.modelHints.length > 0));
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
