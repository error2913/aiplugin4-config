// v5 配置的构建 / 校验 / 序列化。
// 规范见 aiplugin4 仓库 docs/13-模型配置v5方案.md —— 校验规则与插件侧 3.2 节一一对应。
import { KIND_VALUES, API_DIALECTS, PURPOSES, vendorByEndpointPath } from './templates.js';

const PURPOSE_KEYS = PURPOSES.map(p => p.key);

/**
 * 用途绑定归一成**有序数组**：单字符串等价于单元素数组，去重、去空、去两端空白。
 *
 * 与插件侧 `schema.ts` 的 `normalizePurposeList` 是**同一套规则**（跨仓库手抄一份，
 * 由联测 §O 钉住两侧一致）。UI 状态、build、validate、parseImport 都走这里，
 * 避免各写一份导致"生成器认为合法、插件认为非法"。
 */
export function normalizePurposeList(v) {
    if (v === undefined || v === null || v === '') return [];
    const arr = Array.isArray(v) ? v : [v];
    const out = [];
    for (const x of arr) {
        if (typeof x !== 'string') continue;
        const t = x.trim();
        if (t && !out.includes(t)) out.push(t);
    }
    return out;
}
const API_VALUES = API_DIALECTS.map(a => a.value);
const KEY_CHARS_RE = /^[\x21-\x7E]+$/;

/**
 * 用途是否接受某种模型 kind。
 * **必须与插件 `model.ts:489-496` 的 isEligible 一致**，否则生成器会允许绑定
 * 一个插件运行时拒绝的组合（表现为"绑了但没用"）。
 *
 *   text-embedding      → 只接受 embed
 *   image-understanding → 只接受 vision
 *   image-generation    → 只接受 gen
 *   tts                 → 只接受 tts
 *   chat/总结/评判      → 接受除 embed/gen/tts 外的（即 text / vision）
 */
export function isEligibleKind(use, kind) {
    const k = kind || 'text';
    if (use === 'text-embedding') return k === 'embed';
    if (use === 'image-understanding') return k === 'vision';
    if (use === 'image-generation') return k === 'gen';
    if (use === 'tts') return k === 'tts';
    return k !== 'embed' && k !== 'gen' && k !== 'tts';
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 校验请求体里的 thinking 字段：只接受结构化对象（字符串会被 provider 422 拒绝）。
 * 与插件 `schema.ts` 的 checkThinkingField 同一口径 —— 那边是运行时唯一权威。
 */
function checkThinkingField(path, body) {
    if (!isPlainObject(body)) return null;
    if (!Object.prototype.hasOwnProperty.call(body, 'thinking')) return null;
    const value = body.thinking;
    if (value === undefined || value === null) return null;
    if (!isPlainObject(value)) {
        return {
            path: `${path}.thinking`,
            msg: `thinking 需为结构化对象（如 {"type":"enabled"}），不能是 ${JSON.stringify(value)}`,
        };
    }
    return null;
}

/**
 * 某模型类型下可以配置「用途请求体」（`request.bodyByUse`）的用途。
 *
 * 规则与插件 `isEligibleKind` 一致，但**终端用途的模型不给入口**：
 * 嵌入 / 生图 / 语音模型只做一件事，按用途覆盖请求体没有实际意义，
 * 界面直接不显示该折叠（避免一个看不懂的空编辑器）。
 *
 * @returns {object[]} PURPOSES 的子集（保持 UI 顺序）；空数组 = 不显示入口
 */
export function bodyUsePurposesForKind(kind) {
    const k = kind || 'text';
    if (k === 'embed' || k === 'gen' || k === 'tts') return [];
    return PURPOSES.filter(p => isEligibleKind(p.key, k));
}

/**
 * 校验**完整配置对象**，返回问题列表。
 * 每条 { path, msg }，path 用 $.providers[0].models[1].kind 形式（与插件报错格式一致）。
 *
 * 为什么需要它（而不只是 validate(providers, purposes)）：
 * 插件侧校验的是**最终 JSON**（含 version），UI 状态里没有 version（由 build() 写死）。
 * 若生成器只校验 UI 状态，两边对"合法性"的判定就可能不一致 ——
 * 用户按生成器说"没问题"去粘，插件却报错。联测（scripts/integration-config-generator.mjs）
 * 的第 B 组用例正是钉住这一点。
 */
export function validateConfig(cfg) {
    const problems = [];
    const push = (path, msg) => problems.push({ path, msg });

    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        push('$', '配置必须是一个 JSON 对象');
        return problems;
    }

    if (cfg.version !== 5) {
        push('$.version', `版本必须是 5（当前 ${JSON.stringify(cfg.version)}）`);
    }

    const providers = cfg.providers;
    if (!Array.isArray(providers) || providers.length === 0) {
        push('$.providers', '至少需要一个连接');
        return problems;
    }

    // ---- providers ----
    const modelIds = new Map();      // 模型 id -> "providers[i].models[j]"
    const modelKinds = new Map();    // 模型 id -> kind

    providers.forEach((p, i) => {
        const pp = `$.providers[${i}]`;

        // provider（vendor）是可选的**覆盖值**：正常由插件按 baseURL host 自动识别，
        // 用户不必填（方案 2.3.2）。只在"显式写了"时校验它非空。
        if (p.provider !== undefined && p.provider !== null && p.provider !== '') {
            if (typeof p.provider !== 'string' || !p.provider.trim()) {
                push(`${pp}.provider`, 'provider 需为非空字符串（留空则按 URL 自动识别）');
            }
        }

        if (!API_VALUES.includes(p.api)) {
            push(`${pp}.api`, `api "${p.api}" 非法（可选：${API_VALUES.join(' / ')}）`);
        }

        const url = String(p.baseURL || '').trim();
        if (!url) {
            push(`${pp}.baseURL`, '缺少 baseURL（v5 不再兜默认值）');
        } else if (!/^https?:\/\//i.test(url)) {
            push(`${pp}.baseURL`, `baseURL 需以 http:// 或 https:// 开头（当前 "${url}"）`);
        }

        const key = String(p.apiKey || '').trim();
        if (!key) {
            push(`${pp}.apiKey`, '缺少 API Key');
        } else if (!KEY_CHARS_RE.test(key)) {
            push(`${pp}.apiKey`, 'API Key 含不可打印字符（HTTP 头只能携带 \\x21-\\x7E）');
        }

        (p.models || []).forEach((m, j) => {
            const mp = `${pp}.models[${j}]`;
            const mid = String(m.id || '').trim();
            if (!mid) {
                push(`${mp}.id`, '缺少 id');
            } else if (modelIds.has(mid)) {
                push(`${mp}.id`, `模型 id "${mid}" 与 ${modelIds.get(mid)} 重复（需全局唯一）`);
            } else {
                modelIds.set(mid, mp);
            }
            if (!String(m.name || '').trim()) push(`${mp}.name`, '缺少模型名');
            if (m.kind && !KIND_VALUES.includes(m.kind)) {
                push(`${mp}.kind`, `kind "${m.kind}" 非法（可选：${KIND_VALUES.join(' / ')}）`);
            } else {
                modelKinds.set(mid, m.kind || 'text');
            }

            // ---- request（逐模型请求覆盖）----
            // 与插件 schema.ts 同口径：request 是对象；其中 bodyByUse（用途 → 请求体）
            // 的键必须是已知用途、值必须是对象；body.thinking 只接受结构化对象。
            if (m.request !== undefined) {
                if (!isPlainObject(m.request)) {
                    push(`${mp}.request`, 'request 需为对象');
                } else {
                    const bbu = m.request.bodyByUse;
                    if (bbu !== undefined) {
                        if (!isPlainObject(bbu)) {
                            push(`${mp}.request.bodyByUse`, 'bodyByUse 需为对象（用途 → 请求体）');
                        } else {
                            const kind = m.kind || 'text';
                            for (const [use, body] of Object.entries(bbu)) {
                                const upath = `${mp}.request.bodyByUse.${use}`;
                                if (!PURPOSE_KEYS.includes(use)) {
                                    push(upath, `未知用途（可选：${PURPOSE_KEYS.join(' / ')}）`);
                                    continue;
                                }
                                if (!isPlainObject(body)) {
                                    push(upath, '请求体需为对象');
                                    continue;
                                }
                                const thinkingIssue = checkThinkingField(upath, body);
                                if (thinkingIssue) push(thinkingIssue.path, thinkingIssue.msg);
                                if (!isEligibleKind(use, kind)) {
                                    push(upath, `模型类型是 ${kind}，不适用于「${use}」用途`);
                                }
                            }
                        }
                    }
                }
            }
        });
    });

    // ---- purposes ----
    // 值是**有序数组**（下标越小越优先）。单字符串仍接受（手写配置常见），归一为单元素数组。
    for (const [k, v] of Object.entries(cfg.purposes || {})) {
        if (!PURPOSE_KEYS.includes(k)) {
            push(`$.purposes.${k}`, `未知用途（可选：${PURPOSE_KEYS.join(' / ')}）`);
            continue;
        }
        if (Array.isArray(v) && v.some(x => typeof x !== 'string')) {
            push(`$.purposes.${k}`, '用途绑定数组里只能放模型 id 字符串');
            continue;
        }
        if (!Array.isArray(v) && v !== null && v !== undefined && v !== '' && typeof v !== 'string') {
            push(`$.purposes.${k}`, '用途绑定需为模型 id 字符串，或模型 id 的有序数组');
            continue;
        }
        normalizePurposeList(v).forEach((id, j) => {
            const p = Array.isArray(v) ? `$.purposes.${k}[${j}]` : `$.purposes.${k}`;
            if (!modelIds.has(id)) {
                push(p, `引用的模型 "${id}" 不存在`);
                return;
            }
            // 用途与模型类型必须匹配（对应插件 isEligible，model.ts:489-496）
            const kind = modelKinds.get(id);
            if (!isEligibleKind(k, kind)) {
                push(p, `模型 "${id}" 的类型是 ${kind}，不适用于「${k}」用途（插件会忽略该绑定）`);
            }
        });
    }

    return problems;
}

/**
 * 校验 UI 状态（providers + purposes）。
 * 等价于对"build() 会产出的那份配置"做一次完整校验 —— version 由这里补成 5。
 * 需要校验一份**已存在的完整 JSON**（比如导入的内容）时用 validateConfig()。
 */
export function validate(providers, purposes) {
    // 停用的连接不参与校验：它的字段错误/空 Key 不应阻止复制；
    // 绑定到它模型的用途也会在 build 时被过滤掉。
    const list = providers || [];
    const active = list.filter(p => p.enabled !== false);
    // 只过滤“停用连接里的模型”绑定；手写/导入里指向不存在模型的绑定仍要报错
    const disabledIds = new Set(collectModelIds(list.filter(p => p.enabled === false)));
    const filteredPurposes = {};
    for (const [k, v] of Object.entries(purposes || {})) {
        if (Array.isArray(v)) {
            const kept = v.filter(id => !disabledIds.has(id));
            if (kept.length) filteredPurposes[k] = kept;
        } else if (typeof v === 'string') {
            if (v && !disabledIds.has(v)) filteredPurposes[k] = v;
        } else {
            // 非法类型原样交给 validateConfig 报错，避免这里静默吞掉
            filteredPurposes[k] = v;
        }
    }
    return validateConfig({ version: 5, providers: active, purposes: filteredPurposes });
}

/**
 * 由 UI 状态构建 v5 配置对象。
 * 只输出有意义的字段（省略空值），保持配置紧凑。
 * @param {object[]} providers
 * @param {object} purposes
 *
 * 注意：**不输出 groups**（用途组的请求体机制已随插件移除）。请求体覆盖只走
 * 逐模型的 `providers[].models[].request`（含 `bodyByUse`），`build()` 原样透传。
 */
export function build(providers, purposes) {
    const out = { version: 5 };
    // 停用的连接直接从生成配置里移除（不写 enabled 字段），绑定到它模型的用途也一并过滤
    const active = (providers || []).filter(p => p.enabled !== false);
    const activeIds = new Set(collectModelIds(active));

    out.providers = active.map(p => {
        const o = { api: p.api, baseURL: p.baseURL, apiKey: p.apiKey };
        // provider 只在**显式覆盖**时写出；留空 = 插件按 baseURL host 自动识别（方案 2.3.2）
        if (p.provider) o.provider = p.provider;
        if (p.displayName) o.displayName = p.displayName;
        if (p.timeout) o.timeout = p.timeout;
        if (p.request && Object.keys(p.request).length) o.request = p.request;
        // 空数组表示"启动时自动拉取"——按方案 6.2，此时**不写** models 字段
        const models = (p.models || []).map(m => {
            const mo = { id: m.id, name: m.name };
            if (m.kind) mo.kind = m.kind;
            if (m.contextWindow) mo.contextWindow = m.contextWindow;
            if (m.maxTokens) mo.maxTokens = m.maxTokens;
            if (m.request && Object.keys(m.request).length) mo.request = m.request;
            if (m.bodyMode) mo.bodyMode = m.bodyMode;
            return mo;
        });
        if (models.length) o.models = models;
        return o;
    });

    // 用途绑定写成**有序数组**（插件按这个顺序取用：首选正常用，失败顺着往后切）。
    // 只绑一个时也写数组 —— 形状统一，插件侧不必区分两种写法。
    const usedPurposes = {};
    for (const k of PURPOSE_KEYS) {
        const list = normalizePurposeList(purposes && purposes[k]).filter(id => activeIds.has(id));
        if (list.length) usedPurposes[k] = list;
    }
    if (Object.keys(usedPurposes).length) out.purposes = usedPurposes;

    return out;
}

/** 密集格式序列化（v5 约定的承载形式） */
export function serialize(cfg) {
    return JSON.stringify(cfg);
}

/** 缩进格式（供预览/调试，不是最终粘贴内容） */
export function serializePretty(cfg) {
    return JSON.stringify(cfg, null, 2);
}

/**
 * 遮蔽 API Key：把每个 provider 的 apiKey 换成占位符，便于截图分享。
 * 注意只改副本，不动原状态。
 */
export function maskKeys(cfg) {
    const copy = JSON.parse(JSON.stringify(cfg));
    for (const p of copy.providers || []) {
        if (p.apiKey) p.apiKey = 'sk-xxxx';
    }
    return copy;
}

/** 生成唯一的模型 id：优先裸名，重复则加序号 */
export function uniqueModelId(name, existing) {
    const base = String(name || 'model')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')   // 斜杠/点号等转连字符
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'model';
    if (!existing.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
        const cand = `${base}-${i}`;
        if (!existing.has(cand)) return cand;
    }
    return `${base}-${Date.now()}`;
}

/** 收集当前所有模型 id（供唯一性生成用） */
export function collectModelIds(providers) {
    const s = new Set();
    for (const p of providers || []) for (const m of p.models || []) if (m.id) s.add(m.id);
    return s;
}

// ---------------------------------------------------------------- 导入（build 的逆）

/**
 * 已从插件与生成器中**彻底移除**的用途（`ChatModelUse` / schema / 出厂配置都不再有）。
 * 旧导出、老草稿、手写配置里仍可能带着它们。
 */
export const REMOVED_PURPOSES = ['compression'];

/**
 * 剔除已移除的用途绑定，返回**新对象**（不改入参）。
 *
 * `parseImport()`（导入旧配置）与 `app.js` 的 `loadDraft()`（读旧浏览器草稿）共用，
 * 避免两处各写一份规则。
 */
export function stripRemovedPurposes(purposes) {
    const out = {};
    if (!purposes || typeof purposes !== 'object' || Array.isArray(purposes)) return out;
    for (const [k, v] of Object.entries(purposes)) {
        if (REMOVED_PURPOSES.includes(k)) continue;
        out[k] = v;
    }
    return out;
}

/**
 * 把一份 v5 配置文本解析成**生成器的 UI 状态**（`build()` 的逆）。
 *
 * 与 build 的往返约定：
 *   - `providers[]` → 连接数组（`uid`/`templateId`/`mode` 由 app.js 补，属 UI 概念）
 *   - `purposes` → 用途绑定
 *   - `models[].request`（含 `bodyByUse`）/ `bodyMode` / `contextWindow` / `maxTokens` **原样保留**
 *   - `groups[]` → **已停用**：丢弃并给出一条明确警告（请求体覆盖改走 models[].request.bodyByUse）
 *
 * 旧配置兼容：已移除的用途（见 `REMOVED_PURPOSES`，目前是 compression）会在
 * **校验之前**被清洗掉并给出警告 —— 否则旧导出会被判"未知用途"而整份导入失败。
 *
 * 返回的 state **只含 providers / purposes**：uid、templateId、mode 等是纯 UI 概念，
 * 由 app.js 的 applyImportedState() 补。旧草稿里的 useBodies / judgePreset 也不再表达。
 *
 * @returns {{ok:boolean, state?:{providers:object[], purposes:object}, issues:Array, warnings:string[]}}
 */
export function parseImport(text) {
    const warnings = [];
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, issues: [{ path: '$', msg: '内容为空' }], warnings };

    let cfg;
    try {
        cfg = JSON.parse(raw);
    } catch (e) {
        return { ok: false, issues: [{ path: '$', msg: 'JSON 语法错误：' + (e && e.message ? e.message : String(e)) }], warnings };
    }

    // ---- 旧配置清洗（**必须在 validateConfig 之前**）----
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
        // 1) 已移除的用途（compression）：旧导出/手写配置里还带着它时，直接校验会被判
        //    "未知用途"→ 整份导入失败。先剔除再校验，并明确告知改了什么（不静默改用户数据）。
        let strippedLegacy = false;
        if (cfg.purposes && typeof cfg.purposes === 'object' && !Array.isArray(cfg.purposes)) {
            const cleaned = stripRemovedPurposes(cfg.purposes);
            if (Object.keys(cleaned).length !== Object.keys(cfg.purposes).length) strippedLegacy = true;
            cfg.purposes = cleaned;
        }
        if (strippedLegacy) warnings.push('旧配置中的「压缩」用途已移除，已自动忽略。');

        // 2) 用途组（groups）已停用：插件侧删掉了这套机制，请求体覆盖改走
        //    `models[].request.bodyByUse`。丢掉输入里的 groups 并明确警告 ——
        //    既不静默吞用户数据，也不让它把整份导入判成非法。
        if ('groups' in cfg) {
            const groups = cfg.groups;
            const hadContent = Array.isArray(groups) ? groups.length > 0 : !!groups;
            if (hadContent) {
                warnings.push('旧配置的用途组请求体（groups）已停用，已忽略；请改用每个模型的「用途请求体」（models[].request.bodyByUse）。');
            }
            delete cfg.groups;
        }
        // 3) 旧 UI 草稿键不是 v5 配置字段（手写/旧版可能带进来）—— 忽略即可
        delete cfg.useBodies;
        delete cfg.judgePreset;
    }

    // 与插件同口径校验（validateConfig 已包含 version 检查）
    const issues = validateConfig(cfg);
    if (issues.length) return { ok: false, issues, warnings };

    const providers = (cfg.providers || []).map(p => {
        // provider 是可选覆盖值，留空由插件按 URL 识别。
        //
        // 但有一种情况**必须补上**：host 认不出、只有**路径**能认出 vendor
        // （典型：把百炼原生的完整端点当 baseURL 填）。这时配置里不写 provider，
        // 插件只能靠路径反推 —— 能work，但配置不自描述：地址一改就坏，
        // 而且生成器界面上也说不清"当前生效的是谁"。
        // 补上并明确告知（不静默改用户数据）。
        let provider = p.provider || '';
        let inferred = false;
        if (!provider) {
            const byPath = vendorByEndpointPath(p.baseURL);
            if (byPath) { provider = byPath; inferred = true; }
        }
        if (inferred) {
            warnings.push(
                `连接「${p.displayName || p.baseURL}」的地址是完整接口端点、`
                + `供应商无法从域名识别，已按路径补上 provider="${provider}"。`,
            );
        }
        return {
            provider,
            api: p.api,
            baseURL: p.baseURL,
            apiKey: p.apiKey || '',
            models: (p.models || []).map(m => {
                const o = { id: m.id, name: m.name };
                if (m.kind) o.kind = m.kind;
                if (m.contextWindow) o.contextWindow = m.contextWindow;
                if (m.maxTokens) o.maxTokens = m.maxTokens;
                // 逐模型 request 原样保留（含 bodyByUse）：不做任何解析/重组，
                // 否则「导入→导出」会与原文漂移。
                if (m.request && Object.keys(m.request).length) o.request = m.request;
                if (m.bodyMode) o.bodyMode = m.bodyMode;
                return o;
            }),
            enabled: p.enabled !== false,
            displayName: p.displayName || '',
            timeout: p.timeout || 0,
            request: p.request && Object.keys(p.request).length ? p.request : {},
        };
    });

    // 导入：归一成有序数组（单字符串也接受），UI 状态统一用数组
    const purposes = {};
    for (const [k, v] of Object.entries(cfg.purposes || {})) {
        const list = normalizePurposeList(v);
        if (list.length) purposes[k] = list;
    }

    return { ok: true, state: { providers, purposes }, issues: [], warnings };
}
