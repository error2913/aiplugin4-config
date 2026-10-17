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
 *   chat/压缩/总结/评判  → 接受除 embed/gen/tts 外的（即 text / vision）
 */
export function isEligibleKind(use, kind) {
    const k = kind || 'text';
    if (use === 'text-embedding') return k === 'embed';
    if (use === 'image-understanding') return k === 'vision';
    if (use === 'image-generation') return k === 'gen';
    if (use === 'tts') return k === 'tts';
    return k !== 'embed' && k !== 'gen' && k !== 'tts';
}

/**
 * 校验**完整配置对象**，返回问题列表。
 * 每条 { path, msg }，path 用 $.providers[0].models[1].kind 形式（与插件报错格式一致）。
 *
 * 为什么需要它（而不只是 validate(providers, purposes)）：
 * 插件侧校验的是**最终 JSON**（含 version 与 groups），而 UI 状态里没有这两项
 * （groups 由 build() 派生）。若生成器只校验 UI 状态，两边对"合法性"的判定就会不一致 ——
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

    // ---- groups（插件侧会校验，为保持一致这里也校验）----
    if (cfg.groups !== undefined) {
        if (!Array.isArray(cfg.groups)) {
            push('$.groups', 'groups 需为数组');
        } else {
            cfg.groups.forEach((g, i) => {
                const gp = `$.groups[${i}]`;
                if (!g || typeof g !== 'object' || Array.isArray(g)) {
                    push(gp, '用途组必须是对象');
                    return;
                }
                if (!Array.isArray(g.purposes) || g.purposes.length === 0) {
                    push(`${gp}.purposes`, '用途组需要非空的 purposes 数组');
                    return;
                }
                g.purposes.forEach((u, j) => {
                    if (!PURPOSE_KEYS.includes(u)) push(`${gp}.purposes[${j}]`, `未知用途 ${JSON.stringify(u)}`);
                });
            });
        }
    }

    return problems;
}

/**
 * 校验 UI 状态（providers + purposes）。
 * 等价于对"build() 会产出的那份配置"做一次完整校验 —— 但**不含 groups**，
 * 因为 UI 状态里没有 groups（由 build() 按绑定的用途派生），无从不一致。
 * 需要校验完整 JSON（含 version/groups）时用 validateConfig()。
 */
export function validate(providers, purposes) {
    return validateConfig({ version: 5, providers, purposes });
}

/**
 * 用途组的**默认请求体**（按用途分类，不是按 vendor）。
 *
 * 与插件的关系（重要）：
 *   插件有两套默认 —— `model_defaults.ts`（代码兜底，配置里没有 groups 时用）与
 *   出厂 `DEFAULT_V5_CONFIG` 的 groups（配置里写了的优先）。
 *   本表对齐的是**出厂配置那一套**（含 temperature/top_p），因为生成器的产出就是要写进配置的。
 *   联测 §G 会拿插件真实对象逐字段比对，防止这里悄悄漂移。
 *
 * 为什么按用途而不是按 vendor：识图/嵌入**没有** vendor 预设机制
 * （插件的 `MediaPresetUse` 只有 tts / image-generation），
 * 它们的结构由代码默认 + provider 协议转换决定，所以这里只能给通用结构。
 * 用户需要按 vendor 改，就用「请求体覆盖」编辑区。
 */
export const DEFAULT_USE_BODIES = {
    chat: { temperature: 1, top_p: 1, max_tokens: 8192, stop: null, stream: false },
    'image-understanding': { temperature: 1, max_tokens: 2048, stop: null, stream: false },
    'text-embedding': { encoding_format: 'float', dimensions: 1024 },
};

/** 用途组的分组方式：哪些用途共用一个 body（chat 系四个共享） */
const GROUP_MEMBERS = {
    chat: ['chat', 'compression', 'summarization', 'judge'],
    'image-understanding': ['image-understanding'],
    'text-embedding': ['text-embedding'],
};

/**
 * 生成用途组。
 * @param {object} purposes 用途绑定
 * @param {object} [useBodies] 用途组 body 覆盖（键同 DEFAULT_USE_BODIES）；未给的用默认
 * @param {object[]} [extraGroups] 导入时保留下来的非标准分组（原样附在最后）
 */
function defaultGroups(purposes, useBodies, extraGroups) {
    const used = new Set(Object.keys(purposes || {}).filter(k => normalizePurposeList(purposes[k]).length > 0));
    // 被非标准分组覆盖的用途：不再由标准分组给 body，避免"同一个用途两个组"互相盖
    const covered = new Set();
    for (const g of extraGroups || []) {
        for (const u of g.purposes || []) covered.add(u);
    }
    const out = [];
    for (const [key, members] of Object.entries(GROUP_MEMBERS)) {
        // 该族一个用途都没绑定 → 不产组（避免塞无用配置）
        if (!members.some(u => used.has(u))) continue;
        // 该族**只要有一个**用途被非标准分组覆盖，就整族交给那些分组。
        // 不能只剔除被覆盖的那个：那会造出一个**新的非标准分组**
        // （如 [compression,summarization,judge]），于是反复导入导出时分组不断增殖。
        if (members.some(u => covered.has(u))) continue;
        const override = useBodies && useBodies[key];
        const body = override && typeof override === 'object' && !Array.isArray(override)
            ? override
            : DEFAULT_USE_BODIES[key];
        out.push({ purposes: [...members], body });
    }
    // 导入保留的分组按原顺序附后（顺序影响插件的合并优先级）
    for (const g of extraGroups || []) out.push(g);
    return out;
}

/**
 * 由 UI 状态构建 v5 配置对象。
 * 只输出有意义的字段（省略空值），保持配置紧凑。
 * @param {object[]} providers
 * @param {object} purposes
 * @param {object} [useBodies] 用途组 body 覆盖（见 DEFAULT_USE_BODIES）
 * @param {object[]} [extraGroups] 导入保留的非标准用途组
 */
export function build(providers, purposes, useBodies, extraGroups) {
    const out = { version: 5 };

    out.providers = (providers || []).map(p => {
        const o = { api: p.api, baseURL: p.baseURL, apiKey: p.apiKey };
        // provider 只在**显式覆盖**时写出；留空 = 插件按 baseURL host 自动识别（方案 2.3.2）
        if (p.provider) o.provider = p.provider;
        if (p.enabled === false) o.enabled = false;
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
        const list = normalizePurposeList(purposes && purposes[k]);
        if (list.length) usedPurposes[k] = list;
    }
    if (Object.keys(usedPurposes).length) out.purposes = usedPurposes;

    const groups = defaultGroups(usedPurposes, useBodies, extraGroups);
    if (groups.length) out.groups = groups;

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

/** 判断两个用途数组是否为同一集合（忽略顺序） */
function samePurposeSet(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const s = new Set(a);
    return b.every(x => s.has(x));
}

/**
 * 把一份 v5 配置文本解析成**生成器的 UI 状态**（`build()` 的逆）。
 *
 * 与 build 的往返约定：
 *   - `providers[]` → 连接数组（`uid`/`templateId`/`mode` 由 app.js 补，属 UI 概念）
 *   - `purposes` → 用途绑定
 *   - `groups[]` → 命中已知分组的 body 进 `useBodies`；**其余原样留在 `extraGroups`**
 *   - `models[].request` / `bodyMode` / `contextWindow` / `maxTokens` 全部保留
 *
 * 为什么要有 `extraGroups`：本工具只认三种固定分组（对话系/识图/嵌入），
 * 手写配置可能有别的分组方式。丢掉它们等于**静默改坏用户配置**，所以原样保留并**明确警告**。
 *
 * @returns {{ok:boolean, state?:object, issues:Array, warnings:string[]}}
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

    const useBodies = {};
    const extraGroups = [];
    for (const g of cfg.groups || []) {
        const hit = Object.entries(GROUP_MEMBERS).find(([, members]) => samePurposeSet(members, g.purposes));
        if (hit && g.body && Object.keys(g.body).length) {
            useBodies[hit[0]] = g.body;
        } else if (hit) {
            // 命中已知分组但没写 body → 用内置默认即可，不必记
        } else {
            // 认不出的分组：原样保留，导出时按原顺序附在标准分组之后
            extraGroups.push(g);
        }
    }
    if (extraGroups.length) {
        warnings.push(
            `配置里有 ${extraGroups.length} 个用途组的用途组合不是本工具的标准分组（对话系 / 识图 / 嵌入），`
            + `已**原样保留**并在导出时附在标准分组之后。注意：分组顺序会影响插件的合并优先级，`
            + `如需精确控制请直接改 JSON。`,
        );
    }
    // 绑定了用途但没有任何分组给它 body → 导出时会补内置默认，说一声免得用户以为导入丢了
    const boundUses = new Set(Object.keys(purposes));
    const groupedUses = new Set();
    for (const g of cfg.groups || []) {
        for (const u of g.purposes || []) groupedUses.add(u);
    }
    for (const [key, members] of Object.entries(GROUP_MEMBERS)) {
        // 只算"绑定了但没被任何分组覆盖"的用途 —— 被非标准分组覆盖的不算缺
        const ungrouped = members.filter(u => boundUses.has(u) && !groupedUses.has(u));
        if (ungrouped.length) {
            warnings.push(
                `「${key}」在配置里没有对应 body，导出时会补上内置默认值（涉及：${ungrouped.join('、')}）。`,
            );
        }
    }

    return { ok: true, state: { providers, purposes, useBodies, extraGroups }, issues: [], warnings };
}
