// 联网配置生成器（Web 分区）纯逻辑自检：node tests/web-check.mjs
// 只验证 web.js 的构建 / 校验 / 导入，不涉及 DOM。
import {
    WEB_DEFAULTS, WEB_PRESETS, makeProvider, supportsFetch,
    validateWeb, buildWeb, serializeWeb, maskWebKeys, parseWebImport,
} from '../js/web.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`); }
};

// 十家内置方言 + generic
const expectedDialects = ['deepseek', 'searxng', 'kimi', 'brave', 'tavily', 'serper', 'bocha', 'zhipu', 'exa', 'firecrawl', 'generic'];
check('内置方言齐全（10 家 + generic）', expectedDialects.every(d => !!WEB_PRESETS[d]) && Object.keys(WEB_PRESETS).length === expectedDialects.length,
    Object.keys(WEB_PRESETS).join(','));

const brave = makeProvider('brave', 'wb');
check('Brave 预设 baseURL', brave.baseURL === 'https://api.search.brave.com');
check('Brave 不支持抓取', supportsFetch({ ...brave, id: 'brave', enabled: true }) === false);
const fc = makeProvider('firecrawl', 'wf');
check('Firecrawl 支持抓取', supportsFetch({ ...fc, id: 'firecrawl', enabled: true }) === true);
check('Bocha 预设 baseURL', makeProvider('bocha', 'wbo').baseURL === 'https://api.bocha.cn');
check('Kimi 预设 baseURL', makeProvider('kimi', 'wk').baseURL === 'https://api.moonshot.ai');
check('Kimi 支持抓取', supportsFetch({ ...makeProvider('kimi', 'wk2'), id: 'kimi', enabled: true }) === true);
check('智谱预设 baseURL', makeProvider('zhipu', 'wz').baseURL === 'https://open.bigmodel.cn/api/paas/v4');

const ds = makeProvider('deepseek', 'w1');
ds.id = 'deepseek';
ds.apiKey = 'sk-test';
const sx = makeProvider('searxng', 'w2');
sx.id = 'searxng';
const providers = [ds, sx];

const v = validateWeb(providers, { ...WEB_DEFAULTS });
check('DeepSeek + SearXNG 无阻断问题', v.problems.length === 0, JSON.stringify(v.problems));
check('填了 Key 时无 warning', v.warnings.length === 0, JSON.stringify(v.warnings));

const cfg = buildWeb(providers, WEB_DEFAULTS);
check('version = 1', cfg.version === 1);
check('routes.search 按 provider 顺序', JSON.stringify(cfg.routes.search) === JSON.stringify(['deepseek', 'searxng']), JSON.stringify(cfg.routes));
check('routes.fetch 只含支持抓取的方言', JSON.stringify(cfg.routes.fetch) === JSON.stringify(['deepseek']), JSON.stringify(cfg.routes));
check('非 generic 不写 search/fetch 描述', cfg.providers[0].search === undefined && cfg.providers[1].fetch === undefined);
check('SearXNG 默认地址写入', cfg.providers[1].baseURL === 'https://searxng.fishwhite.top');

const masked = maskWebKeys(cfg);
check('遮蔽 Key 不修改原对象', masked.providers[0].apiKey === 'sk-xxxx' && cfg.providers[0].apiKey === 'sk-test');

const g = makeProvider('generic', 'w3');
g.id = 'my-search';
g.baseURL = 'https://api.example.com';
check('generic 默认描述可解析', validateWeb([g], WEB_DEFAULTS).problems.length === 0, JSON.stringify(validateWeb([g], WEB_DEFAULTS).problems));
const gCfg = buildWeb([g], WEB_DEFAULTS);
check('generic 写出 search/fetch 描述', !!gCfg.providers[0].search && !!gCfg.providers[0].fetch);

g.searchJson = '{ broken';
check('generic 坏 JSON → problem', validateWeb([g], WEB_DEFAULTS).problems.length > 0);

const noKey = makeProvider('deepseek', 'w4');
noKey.id = 'deepseek-2';
const v2 = validateWeb([noKey], WEB_DEFAULTS);
check('DeepSeek 缺 Key → warning 而非 problem', v2.problems.length === 0 && v2.warnings.length === 1, JSON.stringify(v2));

const imported = parseWebImport(JSON.stringify({ providers: [{ dialect: 'deepseek', apiKey: 'k' }] }));
check('导入最小配置（缺 id/baseURL/defaults）', imported.providers.length === 1 && imported.providers[0].id === 'deepseek');
check('导入默认项归一',
    imported.defaults.count === 10 && imported.defaults.detail === 'summary'
    && imported.defaults.maxContentChars === 5000,
    JSON.stringify(imported.defaults));

let threw = false;
try { parseWebImport('{ not json'); } catch { threw = true; }
check('非法 JSON 导入抛错', threw);

const cfgCompact = buildWeb([ds, sx], WEB_DEFAULTS);
check('默认紧凑单行，格式化才多行', serializeWeb(cfgCompact).indexOf('\n') === -1 && serializeWeb(cfgCompact, true).indexOf('\n') !== -1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
