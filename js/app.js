// 主应用：供应商卡片（一级） + 编辑面板（二级） + v5 输出。
// 交互设计见 aiplugin4 仓库 docs/13-模型配置v5方案.md 第 9.2 节。
import {
    PROVIDER_TEMPLATES, API_DIALECTS, MODEL_KINDS, PURPOSES, KNOWN_VENDORS,
    getTemplate, templateIdForBaseUrl,
    resolveVendorFromUrl, MEDIA_VENDOR_USES, providerForTemplate,
} from './templates.js';
import { decideKind } from './classify.js';
import {
    validate, build, serialize, maskKeys, parseImport,
    uniqueModelId, collectModelIds, isEligibleKind, normalizePurposeList,
} from './v5.js';
import { fetchModelList, FetchError, sortModelEntries } from './fetch-models.js';

const STORAGE_KEY = 'aiplugin4-config-v5-draft';

// ---------------------------------------------------------------- 状态

let uid = 0;
const nextUid = () => `u${++uid}`;

let state = {
    providers: [],
    purposes: {},
    /** 用途组 body 覆盖（键同 v5.js 的 DEFAULT_USE_BODIES）；空 = 用内置默认 */
    useBodies: {},
    /** 导入时保留下来的非标准用途组（原样导出；见 v5.js 的 parseImport） */
    extraGroups: [],
};

/** 编辑面板的草稿（与 state 隔离，取消即丢弃） */
let draft = null;
let saveTimer = null;

// ---------------------------------------------------------------- 持久化
//
// 草稿存 localStorage，**包含 API Key**（刷新不丢，不必反复粘贴）。
//
// 为什么不再清空它：这是本机上的静态页面，而 Key **本来就已经明文存在海豹配置里**，
// 同一台机器、同一个信任边界 —— 再存一份到 localStorage 的**增量**风险很小，
// 代价却是每次刷新都要重贴（实测很烦）。所以改为保留。
//
// 唯一的真实风险场景：把这个页面**托管到公网**（而不是本机打开）。
// 那样 localStorage 属于那个源，同源下的其它脚本能读到它。若你要公网托管，
// 把下面的 `apiKey` 改成 `''` 即可恢复"不落盘"（或改用 sessionStorage 只保本次会话）。

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                providers: state.providers,
                purposes: state.purposes,
                useBodies: state.useBodies || {},
                extraGroups: state.extraGroups || [],
            }));
        } catch (e) {
            // 以前这里是空 catch —— 存储被禁（无痕/站点权限）或写满时**静默失败**，
            // 用户看到的现象是"填了 Key 一刷新就没了"，却完全没有任何提示。
            // 必须说出来：这是唯一能解释该现象的运行时原因。
            console.warn('草稿保存失败（浏览器存储不可用或已满）：', e);
            toast('浏览器存储不可用，配置不会自动保存（刷新会丢）', 'err');
        }
    }, 300);
}

function loadDraft() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const d = JSON.parse(raw);
        if (!d || !Array.isArray(d.providers) || d.providers.length === 0) return null;
        return {
            providers: d.providers.map(p => ({
                uid: nextUid(),
                templateId: p.templateId || templateIdForBaseUrl(p.baseURL, p.api),
                mode: p.mode || (templateIdForBaseUrl(p.baseURL, p.api) === 'custom' ? 'custom' : 'vendor'),
                // provider 是**可选覆盖值**，正常留空由插件按 URL 识别（方案 2.3.2）
                provider: p.provider || '',
                api: p.api || 'openai-completions',
                baseURL: p.baseURL || '',
                // 恢复已保存的 Key（老存档没有该字段时给空串，不会变成 undefined）
                apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
                models: Array.isArray(p.models) ? p.models : [],
                enabled: p.enabled !== false,
                displayName: p.displayName || '',
                timeout: p.timeout || 0,
                request: p.request || {},
            })),
            purposes: d.purposes && typeof d.purposes === 'object' ? d.purposes : {},
            // 旧存档没有这个键 → 兜底成 {}（否则 renderPurposes 读 state.useBodies[key] 会抛）
            useBodies: d.useBodies && typeof d.useBodies === 'object' ? d.useBodies : {},
            extraGroups: Array.isArray(d.extraGroups) ? d.extraGroups : [],
        };
    } catch { return null; }
}

// ---------------------------------------------------------------- 工具

const $ = (id) => document.getElementById(id);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

/** 取 URL 的 host（用于显示名兜底与识别结果展示） */
function hostOf(url) {
    try { return new URL(String(url || '')).hostname.toLowerCase(); } catch { return ''; }
}

/** 连接的展示名：显式 displayName > 识别出的 vendor > host > 兜底 */
function connLabel(p) {
    return p.displayName
        || resolveVendorFromUrl(p.baseURL)
        || hostOf(p.baseURL)
        || '未命名连接';
}

function toast(msg, kind = '') {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast ' + kind;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { t.hidden = true; }, 2600);
}

const CORS_LABEL = {
    allow: { text: '可直连', cls: 'ok', title: '实测：浏览器可直连 /models' },
    block: { text: 'CORS 拦截', cls: 'warn', title: '实测：浏览器直连被 CORS 拒绝，模型名请手动填' },
    unreach: { text: '需代理', cls: 'dim', title: '实测：本机网络不可达（DNS 干扰/被墙）' },
    unknown: { text: '未实测', cls: 'dim', title: '自定义地址，未实测' },
};

// ---------------------------------------------------------------- 一级：卡片列表

/** 上移/下移一个连接。顺序即插件连接顺序，语义见 9.2 */
function moveProvider(index, delta) {
    const j = index + delta;
    if (j < 0 || j >= state.providers.length) return;
    const [p] = state.providers.splice(index, 1);
    state.providers.splice(j, 0, p);
    scheduleSave();
    renderAll();
}

function renderCards() {
    const list = $('cardList');
    list.innerHTML = '';

    state.providers.forEach((p, i) => {
        const card = el('div', 'pcard');

        const head = el('div', 'pcard-head');
        const tpl = getTemplate(p.templateId);
        head.appendChild(Object.assign(el('span', 'pcard-title'), { textContent: connLabel(p) }));
        const cors = CORS_LABEL[tpl.cors] || CORS_LABEL.unknown;
        const badge = el('span', 'cors-badge ' + cors.cls);
        badge.textContent = cors.text;
        badge.title = cors.title;
        head.appendChild(badge);
        card.appendChild(head);

        // 副标题显示识别出的 vendor（或显式覆盖值），让用户看到插件会用什么
        const vendorLine = el('div', 'pcard-id');
        const vendor = p.provider || resolveVendorFromUrl(p.baseURL);
        vendorLine.textContent = vendor ? `provider: ${vendor}` : 'provider: 未识别';
        if (p.provider) vendorLine.title = '手工指定（覆盖自动识别）';
        card.appendChild(vendorLine);

        const meta = el('div', 'pcard-meta');
        meta.textContent = p.models.length
            ? `${p.models.length} 个模型`
            : '未选模型（启动时自动拉取）';
        if (p.enabled === false) {
            const off = el('span', 'off-tag');
            off.textContent = '已禁用';
            meta.appendChild(off);
        }
        card.appendChild(meta);

        const actions = el('div', 'pcard-actions');

        // 顺序调整：providers[] 的**数组顺序即插件连接顺序**，决定用途默认取哪个模型
        // （插件 model.ts:512-513 取候选里的第一个）。所以必须能调。
        const up = el('button', 'btn btn-sm btn-move');
        up.type = 'button';
        up.textContent = '↑';
        up.title = '上移（顺序决定插件默认取哪个模型）';
        up.disabled = i === 0;
        up.onclick = () => moveProvider(i, -1);

        const down = el('button', 'btn btn-sm btn-move');
        down.type = 'button';
        down.textContent = '↓';
        down.title = '下移';
        down.disabled = i === state.providers.length - 1;
        down.onclick = () => moveProvider(i, 1);

        const edit = el('button', 'btn btn-sm btn-edit');
        edit.type = 'button';
        edit.textContent = '编辑';
        edit.onclick = () => openPanel(i);
        const del = el('button', 'btn btn-sm btn-danger');
        del.type = 'button';
        del.textContent = '删除';
        del.onclick = () => {
            if (!confirm(`删除连接「${connLabel(p)}」？\n引用了它模型的用途绑定也会一并清除。`)) return;
            // 清掉引用了该连接模型的用途绑定（绑定是有序数组，要逐个过滤）
            const gone = new Set(p.models.map(m => m.id));
            for (const k of Object.keys(state.purposes)) {
                const kept = normalizePurposeList(state.purposes[k]).filter(v => !gone.has(v));
                if (kept.length) state.purposes[k] = kept;
                else delete state.purposes[k];
            }
            state.providers.splice(i, 1);
            scheduleSave();
            renderAll();
        };
        actions.appendChild(up);
        actions.appendChild(down);
        actions.appendChild(edit);
        actions.appendChild(del);
        card.appendChild(actions);

        list.appendChild(card);
    });

    // 「+ 添加」卡片
    const add = el('div', 'pcard pcard-add');
    add.textContent = '+ 添加';
    add.onclick = () => openPanel(null);
    list.appendChild(add);
}

// ---------------------------------------------------------------- 二级：编辑面板

function openPanel(index) {
    const isNew = index === null;
    if (isNew) {
        const tpl = getTemplate('deepseek');
        draft = {
            uid: nextUid(), isNew: true, templateId: 'deepseek', mode: 'vendor',
            // provider 留空 = 由插件按 baseURL 自动识别（方案 2.3.2）
            provider: '',
            api: tpl.api, baseURL: tpl.baseUrl, apiKey: '',
            models: [], enabled: true, displayName: '', timeout: 0, request: {},
            baseUrlTouched: false, lastVendorTemplateId: 'deepseek',
            fetched: [], fetchMsg: null, fetchKind: null,
        };
    } else {
        const p = state.providers[index];
        const tpl = getTemplate(p.templateId);
        draft = {
            ...JSON.parse(JSON.stringify(p)),
            uid: p.uid, isNew: false, index,
            // 「是否手工改过 URL」的判据 = 当前 URL 是否**偏离该模板的默认值**。
            // 不能一律置 true（那样切换供应商永远不会更新 URL），
            // 也不能一律置 false（那样会覆盖用户的自定义网关地址）。
            baseUrlTouched: String(p.baseURL || '') !== String(tpl.baseUrl || ''),
            lastVendorTemplateId: p.templateId === 'custom' ? 'deepseek' : p.templateId,
            fetched: [], fetchMsg: null, fetchKind: null,
            };
    }
    $('panel').hidden = false;
    $('panelBackdrop').hidden = false;
    renderPanel();
}

function closePanel() {
    draft = null;
    $('panel').hidden = true;
    $('panelBackdrop').hidden = true;
    // 清空面板内容：否则关闭后仍残留上一次的表单 DOM（含重复的 id），
    // 选择器会命中这些陈旧节点，造成"看起来还能操作"的假象。
    $('panelBody').innerHTML = '';
    // 关闭后刷新预览：取消编辑时要把被丢弃的草稿改动**撤回**显示，
    // 否则右侧仍停留在草稿版本，看起来像改动已生效。
    renderOutput();
}

function savePanel() {
    if (!draft) return;
    const {
        uid, isNew, index, baseUrlTouched, lastVendorTemplateId,
        fetched, fetchMsg, fetchKind, fetching,
        ...conn
    } = draft;

    // 模型 id 若被改名，同步更新引用了它的用途绑定
    const oldModels = !isNew ? state.providers[index].models.map(m => m.id) : [];
    const idMap = new Map();
    conn.models.forEach((m, j) => {
        if (oldModels[j] !== undefined && oldModels[j] !== m.id) idMap.set(oldModels[j], m.id);
    });

    if (isNew) state.providers.push({ ...conn, uid: nextUid() });
    else state.providers[index] = { ...conn, uid };

    // 用途绑定跟随模型 id 改名（**逐个元素**重映射：绑定是有序数组，不是单个 id）
    if (idMap.size) {
        for (const k of Object.keys(state.purposes)) {
            state.purposes[k] = normalizePurposeList(state.purposes[k]).map(v => idMap.get(v) || v);
        }
    }
    // 清掉已不存在模型的绑定；整条绑定的模型都没了就删掉该用途
    const alive = collectModelIds(state.providers);
    for (const k of Object.keys(state.purposes)) {
        const kept = normalizePurposeList(state.purposes[k]).filter(v => alive.has(v));
        if (kept.length) state.purposes[k] = kept;
        else delete state.purposes[k];
    }

    scheduleSave();
    closePanel();
    renderAll();
}


function renderPanel() {
    if (!draft) return;
    const body = $('panelBody');
    body.innerHTML = '';
    $('panelTitle').textContent = draft.isNew ? '添加连接' : '编辑连接';

    const tpl = getTemplate(draft.templateId);
    // ---- 模式切换
    const seg = el('div', 'segmented');
    [['vendor', '模型供应商'], ['custom', '自定义 URL']].forEach(([v, label]) => {
        const b = el('button', 'seg-btn' + (draft.mode === v ? ' active' : ''));
        b.type = 'button';
        b.textContent = label;
        b.onclick = () => {
            // 切到自定义时记住当前供应商，切回来要恢复（否则供应商选择丢失）
            if (v === 'custom' && draft.mode === 'vendor') {
                draft.lastVendorTemplateId = draft.templateId;
            }
            if (v === 'vendor' && draft.mode === 'custom') {
                draft.templateId = draft.lastVendorTemplateId || 'deepseek';
                const t = getTemplate(draft.templateId);
                draft.api = t.api;
                // 与 sel.onchange 一致：provider 由模板决定（**现在所有模板都留空** —— 兼容层接管了）
                draft.provider = providerForTemplate(t);
                if (!draft.baseUrlTouched) draft.baseURL = t.baseUrl;
            }
            draft.mode = v;
            renderPanel();
        };
        seg.appendChild(b);
    });
    body.appendChild(field('接入方式', seg));

    // ---- 模式 A：供应商下拉
    if (draft.mode === 'vendor') {
        const sel = document.createElement('select');
        for (const t of PROVIDER_TEMPLATES) {
            const o = document.createElement('option');
            o.value = t.id; o.textContent = t.label;
            sel.appendChild(o);
        }
        sel.value = draft.templateId;
        sel.onchange = () => {
            const t = getTemplate(sel.value);
            draft.templateId = t.id;
            draft.api = t.api;
            // provider 见 providerForTemplate：通常留空走自动识别，
            // 现在没有任何模板需要显式写（曾经只有「百炼原生」，已删除）。
            draft.provider = providerForTemplate(t);
            // URL 没被手改过才跟随供应商切换（方案 9.2 的约定）
            if (!draft.baseUrlTouched) draft.baseURL = t.baseUrl;
            renderPanel();
        };
        body.appendChild(field('供应商', sel, tpl.notes));
    } else {
        draft.templateId = 'custom';
        const note = el('div', 'hint');
        note.textContent = '中转站 / 自部署 / 其他兼容 OpenAI 或 Anthropic 协议的接口。'
            + '需填 API 地址、协议与模型（在「高级自定义」里）。';
        body.appendChild(note);

        // 自定义模式没有可识别的 vendor，给一个显示名让卡片和输出可读。
        // 注意：这是**给人看的名字**，不是机器标识 —— 本设计里没有字段引用它，
        // 凭据也是内联的（apiKey），不需要像 DSH 那样由 Provider ID 派生凭据名。
        // 显示名称是可自由输入的文本：回调里**只能** renderOutput()，不能 renderPanel()。
        // renderPanel() 会重建整个面板（body.innerHTML = ''），把输入框本身换掉，
        // 于是每敲一个字就失焦 —— 表现为"输入状态被重置、只能打一个字"。
        const nameIn = input(draft.displayName, (v) => {
            draft.displayName = v;
            renderOutput();
        });
        nameIn.placeholder = hostOf(draft.baseURL) || 'acme-gateway';
        body.appendChild(field('显示名称（可选）', nameIn,
            '只用于界面与日志展示。留空则用 API 地址的域名。'));
    }

    // ---- 供应商标识：可编辑（留空 = 自动识别）
    // 说明：这是**逃生舱**，但必须可自由输入 —— 插件的 media_presets 收录了一批
    // 只做媒体的 vendor（MiniMax/FishAudio/ElevenLabs/百度/火山方舟/腾讯/Stability/Google Cloud），
    // 它们没有对应的聊天模板，纯下拉会漏掉。
    // 用 let：URL 被手改后要重算（见 updateVendorStatus）。
    let detected = resolveVendorFromUrl(draft.baseURL);
    const vWrap = el('div', 'field');
    const vLabel = el('label', 'field-label');
    vLabel.textContent = '供应商标识';
    vWrap.appendChild(vLabel);

    const vIn = document.createElement('input');
    vIn.type = 'text';
    vIn.value = draft.provider || '';
    vIn.setAttribute('list', 'vendorOptions');
    vIn.placeholder = detected || '未识别（按 OpenAI 兼容处理）';
    vIn.autocomplete = 'off';
    vIn.spellcheck = false;
    vIn.oninput = () => {
        draft.provider = vIn.value.trim();
        updateVendorStatus();
        renderOutput();
    };
    vWrap.appendChild(vIn);

    // datalist：给建议，同时允许自由输入
    const dl = document.createElement('datalist');
    dl.id = 'vendorOptions';
    for (const v of KNOWN_VENDORS) {
        const o = document.createElement('option');
        o.value = v.value;
        o.label = v.label;
        dl.appendChild(o);
    }
    vWrap.appendChild(dl);

    const vStatus = el('div', 'detected-vendor' + (detected || draft.provider ? '' : ' unknown'));
    vWrap.appendChild(vStatus);
    const vNote = el('div', 'field-note');
    vWrap.appendChild(vNote);

    function updateVendorStatus() {
        // **每次重算**：URL 可能刚被手改，而那条路径只调 renderOutput()（不重建面板，
        // 否则会夺走正在输入的 URL 输入框的焦点）。不重算的话这里会一直显示旧结论 ——
        // 实测出现过"URL 已改成专属域名，状态却还写着 当前生效：alibaba"。
        detected = resolveVendorFromUrl(draft.baseURL);
        vIn.placeholder = detected || '未识别（按 OpenAI 兼容处理）';

        const explicit = (draft.provider || '').trim();
        const eff = explicit || detected;
        vStatus.textContent = eff
            ? `当前生效：${eff}${explicit ? '（手工指定）' : '（按 API 地址自动识别）'}`
            : '当前生效：无（按 OpenAI 兼容处理）';
        vStatus.className = 'detected-vendor' + (eff ? '' : ' unknown');

        // 用途支持提示：该 vendor 在插件 media_presets 里收录了哪些媒体用途。
        // 选了不支持的用途时插件会**静默退回通用预设**（打到 /images/generations 之类），
        // 必然失败又没有提示 —— 所以这里提前说出来。
        let usesNote = '';
        if (eff && MEDIA_VENDOR_USES[eff]) {
            const uses = MEDIA_VENDOR_USES[eff];
            const label = (u) => (u === 'tts' ? '语音合成' : '文生图');
            usesNote = `媒体用途：仅收录了 ${uses.map(label).join(' / ')}`
                + `（未收录的用途会退回通用 OpenAI 兼容结构，多半会失败）。`;
        }
        // ---- URL 形态与 provider 不匹配 → 拼出来的地址会 404
        //
        // 这是实测踩到的真坑：百炼有**两套**地址形态，而 provider 决定拼哪条路径后缀：
        //   兼容模式  https://<host>/compatible-mode/v1        + provider=alibaba  → /images/generations
        //   原生      https://<host>/api/v1/services/aigc/...  + provider=dashscope → 原生端点
        // 混搭（如 compatible-mode/v1 + dashscope）会拼成
        //   .../compatible-mode/v1/api/v1/services/aigc/multimodal-generation/generation → **404**
        // 而且响应体是空的，插件只能报个状态码，用户完全看不出原因。
        //
        // 注意 MaaS 专属域名（llm-xxx.maas.aliyuncs.com）**不在**插件的域名表里，
        // 必须手工填 provider —— 所以这个坑在专属部署上尤其容易踩。
        let mismatchNote = '';
        const url = (draft.baseURL || '').toLowerCase();
        if (eff === 'dashscope' && url.includes('/compatible-mode')) {
            mismatchNote = '⚠ 地址是**兼容模式**，但 dashscope 走的是原生端点 —— '
                + '两者会拼出 /compatible-mode/v1/api/v1/services/… → 404。'
                + '这里应填 alibaba（或把地址换成原生 …/api/v1/services/aigc/multimodal-generation/generation）。';
        } else if (eff === 'alibaba' && /\/api\/v1\/services\//.test(url)) {
            mismatchNote = '⚠ 地址是**百炼原生**端点，但 alibaba 走的是兼容模式 —— '
                + '这里应填 dashscope。';
        }

        // ---- 模型与接入方式不兼容
        //
        // 官方文档明确：**Qwen-Audio 不支持 OpenAI 兼容协议，仅支持 DashScope 协议**
        // （见「OpenAI Chat接口兼容」）。所以 qwen-audio-* 系列放在兼容模式连接里
        // **根本没有对应接口** —— 无论 provider 填什么，都会 404。
        // 实测踩过：把 qwen-audio-3.1-tts-flash 和 qwen-image 放同一条兼容模式连接 → TTS 404。
        let modelNote = '';
        const modelNames = (draft.models || []).map(m => m.name || '');
        const qwenAudio = modelNames.filter(n => /qwen-audio/i.test(n));
        if (qwenAudio.length && url.includes('/compatible-mode')) {
            modelNote = `⚠ ${qwenAudio.join(' / ')} 属 Qwen-Audio 系列，**不支持 OpenAI 兼容协议**`
                + '（官方文档：仅支持 DashScope 协议）—— 放在兼容模式连接里必然 404。'
                + '请**另开一条原生连接**：baseURL 填 host 根（不带 /compatible-mode/v1），供应商标识填 dashscope。';
        }

        vNote.textContent = [
            explicit
                ? '已手工指定，覆盖自动识别。'
                : (detected
                    ? '留空即可 —— 已按 API 地址自动识别。用于选择媒体请求结构（语音/生图）与余额端点。'
                    : '该地址未收录。若它代理的是某家原生接口（如百炼原生 wanx、Google Cloud TTS），请在此填写对方标识；否则留空按 OpenAI 兼容处理。'),
            usesNote,
            mismatchNote,
            modelNote,
        ].filter(Boolean).join(' ');
        vNote.classList.toggle('vendor-warn', !!(mismatchNote || modelNote));
    }
    updateVendorStatus();
    body.appendChild(vWrap);

    // ---- API Key
    const keyWrap = el('div', 'key-row');
    const keyIn = document.createElement('input');
    keyIn.type = 'password';
    keyIn.value = draft.apiKey;
    keyIn.placeholder = 'sk-xxxxxxxx';
    keyIn.autocomplete = 'new-password';
    keyIn.spellcheck = false;
    keyIn.oninput = () => { draft.apiKey = keyIn.value; renderOutput(); };
    const eye = el('button', 'btn btn-sm');
    eye.type = 'button'; eye.textContent = '显示';
    eye.onclick = () => {
        const show = keyIn.type === 'password';
        keyIn.type = show ? 'text' : 'password';
        eye.textContent = show ? '隐藏' : '显示';
    };
    keyWrap.appendChild(keyIn); keyWrap.appendChild(eye);
    // 提示要写清两件事：
    //   1. 它进生成的配置是**明文**（v5 既定设计，插件侧也没有环境变量可放）
    //   2. 它**会存在本机浏览器里**（刷新不丢）—— 公用电脑上记得用「清空」擦掉
    body.appendChild(field('API Key', keyWrap,
        '明文存入生成的配置（v5 的既定设计）。会保存在本机浏览器里（刷新不丢）；'
        + '公用电脑用完请点「清空」。分享时请用「遮蔽」导出。'));

    // ---- 连接级「连接设置覆盖」（折叠）
    //
    // 注意命名：这一项**与请求体无关**（那是逐模型的「请求与响应格式」）。
    // 它管的是连接层面的周边接口：模型列表地址、鉴权头、超时、余额查询。
    // 之前我也叫它"请求覆盖"，和逐模型那个撞名、看着像重复做了两遍 —— 已改名。
    //
    // 插件支持在连接上写一段 request 覆盖默认行为，但生成器此前**没有任何界面**能编它 ——
    // 数据模型是通的（build 会写、导入会保留），只是用户只能手改 JSON。
    // 缺了它，下面这些场景都做不到：
    //   · 模型列表不在 <API URL>/models（专属部署常见）→ 要写 list_url
    //   · 鉴权头不是 Authorization → 要写 auth_header_name / headers
    //   · 余额接口不在内置那三家 → 要写 balance_url + balance_json_path
    const connReqEditor = jsonEditor({
        label: '连接设置覆盖' + (draft.request && Object.keys(draft.request).length ? '（已设置）' : ''),
        value: draft.request,
        rows: 6,
        hint: '整段写进配置的 providers[].request —— 只管连接的**周边接口**，与模型请求体无关'
            + '（请求体在「请求与响应格式」里改）。可用键：'
            + 'list_url（模型列表地址，不写则按 <API URL>/models 猜）、'
            + 'auth_header_name / headers（鉴权头与额外头）、timeout（列表拉取超时秒数）、'
            + 'balance_url / balance_json_path / balance_divisor / balance_currency（.ai balance 的余额接口）。'
            + '留空 = 用插件默认。',
        placeholder: '{\n  "list_url": "https://…/v1/models"\n}',
        onCommit: (v) => {
            if (v) draft.request = v; else delete draft.request;
            renderOutput();
        },
    });
    if (draft.request && Object.keys(draft.request).length) connReqEditor.open = true;
    body.appendChild(connReqEditor);

    // ---- API URL / 协议 / 模型选择
    //
    // 这三项都**不是**"高级"：v5 里 `baseURL` 与 `api` 是必填（缺了整份配置被拒），
    // 模型清单则决定各用途能不能用。原先它们折叠在「高级自定义」里，
    // 用户根本找不到模型添加入口 —— 故移出、常显。原「高级自定义」因此没有剩余内容，一并去掉。
    const urlIn = document.createElement('input');
    urlIn.type = 'text';
    urlIn.id = 'urlIn';
    urlIn.value = draft.baseURL;
    urlIn.placeholder = 'https://api.example.com/v1';
    urlIn.oninput = () => {
        draft.baseURL = urlIn.value;
        draft.baseUrlTouched = true;   // 手改后不再被供应商切换覆盖
        $('urlNote').textContent = '已手工修改，切换供应商不会覆盖它。';
        // 状态提示要跟着 URL 走：否则会显示改之前的结论（实测踩过）。
        // 这里**不能** renderPanel() —— 会重建面板、夺走本输入框焦点。
        updateVendorStatus();
        renderOutput();
    };
    const urlNote = el('div', 'field-note');
    urlNote.id = 'urlNote';
    urlNote.textContent = draft.baseUrlTouched && draft.mode === 'vendor'
        ? '已手工修改，切换供应商不会覆盖它。' : '';
    const urlField = field('API URL', urlIn);
    urlField.appendChild(urlNote);
    body.appendChild(urlField);

    // 协议
    const apiSel = document.createElement('select');
    for (const a of API_DIALECTS) {
        const o = document.createElement('option');
        o.value = a.value; o.textContent = a.label;
        o.title = a.hint;
        apiSel.appendChild(o);
    }
    apiSel.value = draft.api;
    apiSel.onchange = () => { draft.api = apiSel.value; renderPanel(); };
    body.appendChild(field('协议', apiSel, API_DIALECTS.find(a => a.value === draft.api)?.hint || ''));

    // 模型选择
    body.appendChild(renderModelPicker());

    // 面板每次重渲染后刷新右侧预览（实时预览）
    renderOutput();
}

/** 模型选择区：拉取 + 手动输入 + 已选列表 */
function renderModelPicker() {
    const wrap = el('div', 'model-picker');
    const title = el('div', 'field-label');
    title.textContent = '模型选择';
    wrap.appendChild(title);
    const hint = el('div', 'field-note');
    hint.textContent = '留空 = 插件启动时自动拉取模型列表（等价 v4 不写 models）。';
    wrap.appendChild(hint);

    // 拉取按钮
    const bar = el('div', 'fetch-bar');
    const btn = el('button', 'btn btn-sm btn-primary');
    btn.type = 'button';
    btn.textContent = draft.fetching ? '拉取中…' : '自动拉取模型列表';
    btn.disabled = !!draft.fetching;
    btn.onclick = () => doFetch();
    bar.appendChild(btn);

    if (draft.fetchMsg) {
        const msg = el('span', 'fetch-msg ' + (draft.fetchKind === 'ok' ? 'ok' : 'err'));
        msg.textContent = draft.fetchMsg;
        bar.appendChild(msg);
    }
    wrap.appendChild(bar);

    // 拉取结果：可点击的模型卡片
    if (draft.fetched.length) {
        const picked = new Set(draft.models.map(m => m.name));
        const grid = el('div', 'model-grid');
        for (const e of draft.fetched) {
            const name = e.id;
            // 优先用供应商自报的能力位（权威）；自报没有时才按名字猜。
            // 两者都拿不到 → kind 留空（不写进配置，交给插件判断）。
            const kind = decideKind({ meta: e.kind, name });
            const chip = el('button', 'model-chip' + (picked.has(name) ? ' picked' : ''));
            chip.type = 'button';
            chip.title = [name, e.displayName, e.contextWindow ? `上下文 ${e.contextWindow}` : '']
                .filter(Boolean).join(' · ');
            const nm = el('div', 'mc-name');
            nm.textContent = name;
            chip.appendChild(nm);
            const kd = el('div', 'mc-kind k-' + (kind || 'unset'));
            // 自报的加「自报」标记，让用户知道这不是猜的
            kd.textContent = kind
                ? (MODEL_KINDS.find(k => k.value === kind)?.label || kind) + (e.kind ? ' · 自报' : '')
                : '类型待定';
            chip.appendChild(kd);
            chip.onclick = () => {
                const at = draft.models.findIndex(m => m.name === name);
                if (at >= 0) draft.models.splice(at, 1);
                else {
                    const ids = collectModelIds([...state.providers, ...(draft.isNew ? [draft] : [])]);
                    draft.models.push({ id: uniqueModelId(name, ids), name, kind });
                }
                renderPanel();
            };
            grid.appendChild(chip);
        }
        wrap.appendChild(grid);
    }

    // 手动输入
    const mi = el('div', 'models-input');
    const mIn = document.createElement('input');
    mIn.type = 'text';
    mIn.placeholder = '手动输入模型名后回车添加';
    const addModel = () => {
        const v = mIn.value.trim();
        if (!v) return;
        if (draft.models.some(m => m.name === v)) { mIn.value = ''; return; }
        const ids = collectModelIds([...state.providers, ...(draft.isNew ? [draft] : [])]);
        // 手输没有元数据可依：只有名字能确定命中终值白名单时才写 kind，否则留空
        draft.models.push({ id: uniqueModelId(v, ids), name: v, kind: decideKind({ name: v }) });
        mIn.value = '';
        renderPanel();
    };
    mIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addModel(); } };
    const addBtn = el('button', 'btn btn-sm');
    addBtn.type = 'button'; addBtn.textContent = '添加';
    addBtn.onclick = addModel;
    mi.appendChild(mIn); mi.appendChild(addBtn);
    wrap.appendChild(mi);

    // 已选列表
    if (draft.models.length) {
        const sel = el('div', 'selected-list');
        draft.models.forEach((m, j) => {
            const row = el('div', 'sel-row');
            const nm = el('span', 'sel-name');
            nm.textContent = m.name;
            row.appendChild(nm);

            const idIn = document.createElement('input');
            idIn.type = 'text';
            idIn.value = m.id;
            idIn.title = '配置里的模型 id（全局唯一，被用途绑定引用）';
            idIn.className = 'sel-id';
            idIn.onchange = () => { m.id = idIn.value.trim() || m.id; };
            row.appendChild(idIn);

            const kSel = document.createElement('select');
            // 首个选项 = **不写 kind**，交给插件判断。
            // 这不是"随便挑"：插件的 manual（配置里的 kind）**绝对优先**，
            // 所以留空反而让插件能用它从 /models 读到的能力位 + 命名兜底，
            // 比我们猜一个（可能是错的）更准。详见 classify.js 的 decideKind。
            const noneOpt = document.createElement('option');
            noneOpt.value = '';
            noneOpt.textContent = '（不指定，由插件判断）';
            noneOpt.title = '不写进配置。插件会用它从 /models 读到的能力位判断，判断不出再按模型名。';
            kSel.appendChild(noneOpt);
            for (const k of MODEL_KINDS) {
                const o = document.createElement('option');
                o.value = k.value; o.textContent = k.label; o.title = k.desc;
                kSel.appendChild(o);
            }
            kSel.value = m.kind || '';
            kSel.onchange = () => { m.kind = kSel.value || undefined; };
            row.appendChild(kSel);

            const rm = el('button', 'btn btn-sm btn-danger');
            rm.type = 'button'; rm.textContent = '×';
            rm.onclick = () => { draft.models.splice(j, 1); renderPanel(); };
            row.appendChild(rm);

            sel.appendChild(row);

            // bodyMode 选择器：**总是渲染**，但没有 request 时禁用。
            //
            // 为什么不按需渲染：提交是在 textarea 的 input 事件里发生的，
            // 那时若调 renderPanel() 重建面板，正在输入的 textarea 会被换掉 —— 立刻失焦，
            // 表现为"只能输入一个字"（这个坑本轮已经踩过一次，见 input() 的注释）。
            // 所以这里只切换 disabled，绝不重渲染。
            const modeWrap = el('div', 'body-mode-row');
            const ml = el('span', 'field-label');
            ml.textContent = '与内置预设的合并方式';
            modeWrap.appendChild(ml);
            const ms = document.createElement('select');
            for (const [val, text, title] of [
                ['', '整体替换（默认）', '规则里的 body 直接替换内置预设，只发规则里写的字段'],
                ['merge', '逐键深合并', '以内置预设为底，用规则里的字段覆盖/补充'],
                ['replace', '整体替换（显式）', '同"整体替换"，但显式写进配置'],
            ]) {
                const o = document.createElement('option');
                o.value = val; o.textContent = text; o.title = title;
                ms.appendChild(o);
            }
            ms.value = m.bodyMode || '';
            ms.onchange = () => {
                if (ms.value) m.bodyMode = ms.value; else delete m.bodyMode;
                renderOutput();
            };
            modeWrap.appendChild(ms);

            const hasOverride = () => !!(m.request && Object.keys(m.request).length);
            const syncMode = () => {
                const on = hasOverride();
                ms.disabled = !on;
                ms.title = on ? '' : '先在「请求与响应格式」里写 body，合并方式才有意义';
            };

            // ---- 逐模型「请求与响应格式」（折叠）
            //
            // 写进配置的 `providers[].models[].request`。分成几个子折叠而不是一个大 JSON 框：
            //   · body / params / prompt 结构自由，用 JSON 框（所见即所写，不做有损拆分）
            //   · **response 字段固定**，做成结构化表单 —— 用户不必知道 JSON，也不会拼错键名
            //   · request（地址/请求头）键也固定，但组合多变，仍用 JSON 框
            const outer = el('details', 'json-editor req-editor');
            const osum = document.createElement('summary');
            osum.textContent = '请求与响应格式' + (hasOverride() ? '（已设置）' : '');
            outer.appendChild(osum);
            const obody = el('div', 'json-editor-body');
            const onote = el('div', 'field-note');
            onote.textContent = '整段写进配置的 models[].request。内置预设已覆盖常见厂商，'
                + '只在结构对不上时改这里（例如接口用 form 表单、或返回结构特殊）。';
            obody.appendChild(onote);

            obody.appendChild(jsonEditor({
                label: '请求体 body',
                value: reqSub(m, 'body'),
                rows: 6,
                // body 与 response 是绝大多数场景要改的两项 —— 默认展开，
                // 否则用户要点两次才够得着（外层一次 + 子层一次）。其余保持折叠。
                open: true,
                hint: '发给接口的请求体模板，用 {占位符} 标出可被 AI/命令覆写的字段：'
                    + '{prompt} / {negative_prompt} / {size} / {voice} / {text} / {model} / {api_key} 等。',
                placeholder: '{\n  "model": "{model}",\n  "prompt": "{prompt}"\n}',
                onCommit: (v) => { setReqSub(m, 'body', v); syncMode(); renderOutput(); },
            }));

            obody.appendChild(responseEditor(m, () => { syncMode(); renderOutput(); }));

            obody.appendChild(jsonEditor({
                label: '地址与请求头 request',
                value: reqSub(m, 'request'),
                rows: 5,
                hint: '可用键：url（绝对地址，优先级最高）、urlSuffix（拼在 API URL 后，写 "" 表示 API URL 原样就是接口地址）、'
                    + 'method、headers、auth_header_name（非 Authorization 时用）、content_type、timeout（秒）、'
                    + 'auth_token / auth_token_scope（百度双密钥换 token）。',
                placeholder: '{\n  "urlSuffix": "/v1/images/generations",\n  "timeout": 120\n}',
                onCommit: (v) => { setReqSub(m, 'request', v); syncMode(); renderOutput(); },
            }));

            obody.appendChild(jsonEditor({
                label: '可覆写参数 params',
                value: reqSub(m, 'params'),
                rows: 5,
                hint: '声明哪些参数 AI/命令可以覆写，以及它们的元信息 —— 工具的参数 schema 就由它生成。'
                    + '每项：{ type, default, min, max, enum, desc }。',
                placeholder: '{\n  "size": { "type": "string", "default": "1024x1024", "desc": "尺寸" }\n}',
                onCommit: (v) => { setReqSub(m, 'params', v); renderOutput(); },
            }));

            obody.appendChild(jsonEditor({
                label: '提示词 prompt',
                value: reqSub(m, 'prompt'),
                rows: 4,
                hint: 'extra 写一段自由提示词，原样注入给 AI（例如"本模型语速范围 0.25~2.0"），'
                    + '帮它正确填上面那些参数。',
                placeholder: '{\n  "extra": "本模型语速范围 0.25~2.0"\n}',
                onCommit: (v) => { setReqSub(m, 'prompt', v); renderOutput(); },
            }));

            outer.appendChild(obody);
            if (hasOverride()) outer.open = true;
            sel.appendChild(outer);

            syncMode();
            sel.appendChild(modeWrap);
        });
        wrap.appendChild(sel);
    }

    return wrap;
}

async function doFetch() {
    draft.fetching = true;
    draft.fetchMsg = '拉取中…';
    draft.fetchKind = null;
    renderPanel();
    try {
        const entries = await fetchModelList({ baseURL: draft.baseURL, api: draft.api, apiKey: draft.apiKey });
        draft.fetched = sortModelEntries(entries);
        const withMeta = entries.filter(e => e.kind).length;
        draft.fetchMsg = `拉到 ${entries.length} 个模型，点击下方卡片选择`
            + (withMeta ? `（其中 ${withMeta} 个由服务商自报了类型）` : '');
        draft.fetchKind = 'ok';
    } catch (e) {
        draft.fetched = [];
        if (e instanceof FetchError) {
            draft.fetchMsg = e.message;
            if (e.detail) draft.fetchMsg += `（${e.detail}）`;
        } else {
            draft.fetchMsg = '拉取失败：' + (e?.message || String(e));
        }
        draft.fetchKind = 'err';
    }
    draft.fetching = false;
    renderPanel();
}

// ---------------------------------------------------------------- 用途绑定

function renderPurposes() {
    const wrap = $('purposeList');
    wrap.innerHTML = '';
    buildPurposesInto(wrap);
}

/**
 * 只重建用途区（不动面板其它部分）。
 *
 * 为什么需要它：点击卡片会改绑定顺序，需要重画角标与顺序摘要。
 * 但**不能**调 renderPanel() —— 那会重建整个面板，把正在输入的其它字段换掉、焦点丢失
 * （这个坑本轮踩过两次，见 jsonEditor 与 bodyMode 的注释）。
 */
function renderPurposesOnly() {
    const wrap = $('purposeList');
    if (!wrap) return;
    wrap.innerHTML = '';
    buildPurposesInto(wrap);
}

/** 用途区的实际构建（renderPurposes / renderPurposesOnly 共用） */
function buildPurposesInto(wrap) {

    // 全部模型（**按用途过滤** —— 见下方 isEligibleKind）
    const all = [];
    for (const p of state.providers) {
        for (const m of p.models) all.push({ id: m.id, name: m.name, kind: m.kind || 'text', provider: connLabel(p) });
    }

    if (all.length === 0) {
        const e = el('div', 'empty-hint');
        e.textContent = '还没有模型。先在连接卡片里选择模型，才能绑定用途。';
        wrap.appendChild(e);
        return;
    }

    const intro = el('div', 'field-note purpose-intro');
    intro.textContent = '点模型卡片即绑定，角标是取用顺序：插件先用 1，'
        + '失败（余额不足/权限不足等）时顺着 2、3… 往后切。再点一次取消绑定。'
        + '一个都不选 = 不写进配置，由插件按该用途候选的第一个取。';
    wrap.appendChild(intro);

    for (const pu of PURPOSES) {
        // 只列该用途接受的 kind（对应插件 isEligible；否则会绑出一个插件运行时忽略的组合）
        const eligible = all.filter(m => isEligibleKind(pu.key, m.kind));
        const order = normalizePurposeList(state.purposes[pu.key]);

        const block = el('div', 'purpose-block');
        const head = el('div', 'purpose-head');
        const lbl = el('span', 'purpose-label');
        lbl.textContent = pu.label;
        lbl.title = pu.hint;
        head.appendChild(lbl);

        // 顺序摘要：把"插件会按什么顺序取用"直接写出来，用户不必自己从角标推。
        const summary = el('span', 'purpose-order');
        if (order.length === 0) {
            summary.textContent = '（不指定）';
            summary.classList.add('dim');
        } else {
            const byId = new Map(eligible.map(m => [m.id, m]));
            summary.textContent = order
                .map((id, i) => `${i + 1}. ${(byId.get(id) || { name: id }).name}`)
                .join(' → ');
        }
        head.appendChild(summary);
        block.appendChild(head);

        if (eligible.length === 0) {
            const why = el('div', 'field-note purpose-why');
            why.textContent = `无可用模型：需要 ${KIND_LABEL_FOR_PURPOSE[pu.key] || '特定类型'} 的模型`;
            block.appendChild(why);
            wrap.appendChild(block);
            continue;
        }

        const cards = el('div', 'purpose-cards');
        for (const m of eligible) {
            const idx = order.indexOf(m.id);          // -1 = 未绑定
            const btn = el('button', 'purpose-chip' + (idx >= 0 ? ' picked' : ''));
            btn.type = 'button';

            // 角标：绑定后显示**序号**（1 起）。用数字而不是勾 —— "第几个"本身就是信息，
            // 顺序决定插件的取用与失败回退顺序。
            const badge = el('span', 'rank-badge');
            if (idx >= 0) badge.textContent = String(idx + 1);
            btn.appendChild(badge);

            const nm = el('span', 'pc-name');
            nm.textContent = m.name;
            btn.appendChild(nm);
            const pv = el('span', 'pc-provider');
            pv.textContent = m.provider;
            btn.appendChild(pv);

            btn.title = idx >= 0
                ? `第 ${idx + 1} 顺位。点一下取消绑定。`
                : '点一下绑定（排到末尾）';
            btn.onclick = () => {
                const cur = normalizePurposeList(state.purposes[pu.key]);
                const at = cur.indexOf(m.id);
                if (at >= 0) cur.splice(at, 1);        // 取消 → 后面的序号自动前移
                else cur.push(m.id);                   // 绑定 → 排到末尾
                if (cur.length) state.purposes[pu.key] = cur;
                else delete state.purposes[pu.key];
                scheduleSave();
                // 只重渲染**用途区**：整面板重建会丢掉其它正在编辑的输入焦点
                renderPurposesOnly();
                renderOutput();
            };
            cards.appendChild(btn);
        }
        block.appendChild(cards);
        wrap.appendChild(block);
    }

    // ---- 请求体覆盖（折叠）
    // 用途组的 body 原先由 v5.js 写死、界面上改不了；这里给出覆盖入口。
    // 只在真有绑定的用途组上出现（没绑就没有对应的 groups 项，改了也没用）。
    const useBodies = state.useBodies || {};   // 旧存档/外部赋值可能没有这个键
    const boundKeys = new Set(Object.keys(state.purposes).filter(k => normalizePurposeList(state.purposes[k]).length > 0));
    const groupKeys = [
        { key: 'chat', members: ['chat', 'compression', 'summarization', 'judge'], label: '对话 / 压缩 / 总结 / 评判' },
        { key: 'image-understanding', members: ['image-understanding'], label: '识图' },
        { key: 'text-embedding', members: ['text-embedding'], label: '向量记忆（嵌入）' },
    ].filter(g => g.members.some(u => boundKeys.has(u)));

    if (groupKeys.length) {
        const outer = el('details', 'json-editor group-bodies');
        const osum = document.createElement('summary');
        osum.textContent = '用途组请求体（高级）';
        outer.appendChild(osum);
        const obody = el('div', 'json-editor-body');
        const onote = el('div', 'field-note');
        onote.textContent = '这几段写进配置的 groups[].body，是该用途组每次请求都带的字段。'
            + '留空 = 用内置默认。识图与嵌入**没有按服务商的预设**（插件的预设只管语音/生图），'
            + '所以按服务商改结构只能在这里改，或用每个模型的「请求与响应格式」。';
        obody.appendChild(onote);

        for (const g of groupKeys) {
            obody.appendChild(jsonEditor({
                label: g.label,
                value: useBodies[g.key],
                rows: 5,
                onCommit: (v) => {
                    if (!state.useBodies) state.useBodies = {};
                    if (v) state.useBodies[g.key] = v; else delete state.useBodies[g.key];
                    scheduleSave();
                    renderOutput();
                },
            }));
        }
        outer.appendChild(obody);
        wrap.appendChild(outer);
    }
}

/** 用途要求的模型类型说明（仅在无可用模型时提示用） */
const KIND_LABEL_FOR_PURPOSE = {
    'image-understanding': '视觉（vision）',
    'text-embedding': '嵌入（embed）',
    'tts': '语音（tts）',
    'image-generation': '生图（gen）',
};

// ---------------------------------------------------------------- 输出

/** 剥离草稿里的纯 UI 字段，得到可写入配置的连接对象 */
function stripDraft(d) {
    const {
        uid, isNew, index, baseUrlTouched, lastVendorTemplateId,
        fetched, fetchMsg, fetchKind, fetching,
        ...conn
    } = d;
    return conn;
}

/**
 * 当前生效的连接列表：编辑面板打开时用草稿覆盖（或追加），否则用已保存状态。
 * 这样编辑过程中右侧预览是**实时**的，而不是等到保存才更新。
 */
function effectiveProviders() {
    if (!draft) return state.providers;
    const copy = state.providers.map(p => ({ ...p }));
    const conn = stripDraft(draft);
    if (draft.isNew) copy.push(conn);
    else if (draft.index >= 0 && draft.index < copy.length) copy[draft.index] = conn;
    return copy;
}

function currentProblems() {
    return validate(effectiveProviders(), state.purposes);
}

function renderOutput() {
    const masked = $('maskKey').checked;
    let cfg = build(effectiveProviders(), state.purposes, state.useBodies, state.extraGroups);
    if (masked) cfg = maskKeys(cfg);
    $('preview').textContent = serialize(cfg);

    const problems = currentProblems();
    const box = $('validationBox');
    if (problems.length === 0) {
        box.hidden = true;
        box.innerHTML = '';
    } else {
        box.hidden = false;
        box.innerHTML = '';
        const t = el('div', 'vtitle');
        t.textContent = `配置有 ${problems.length} 处问题，修正后才能复制：`;
        box.appendChild(t);
        const ul = document.createElement('ul');
        for (const p of problems) {
            const li = document.createElement('li');
            const code = el('code');
            code.textContent = p.path;
            li.appendChild(code);
            li.appendChild(document.createTextNode(' ' + p.msg));
            ul.appendChild(li);
        }
        box.appendChild(ul);
    }
    $('copyBtn').disabled = problems.length > 0;
}

function renderAll() {
    renderCards();
    renderPurposes();
    renderOutput();
}

// ---------------------------------------------------------------- 表单小工具

function field(labelText, control, note) {
    const f = el('div', 'field');
    const l = el('label', 'field-label');
    l.textContent = labelText;
    f.appendChild(l);
    f.appendChild(control);
    if (note) {
        const n = el('div', 'field-note');
        n.textContent = note;
        f.appendChild(n);
    }
    return f;
}

/**
 * 造一个文本输入框。
 *
 * onInput 回调里**不要调 renderPanel()** —— 它会重建整个面板，把本输入框换掉，
 * 导致每次按键都失焦（表现为"只能输入一个字"）。需要联动时只调 renderOutput()。
 */
function input(value, onInput) {
    const i = document.createElement('input');
    i.type = 'text';
    i.value = value || '';
    i.oninput = () => onInput(i.value);
    return i;
}

/**
 * 折叠的 JSON 编辑区（「请求体覆盖」用它）。
 *
 * 行为约定（重要，别简化）：
 *   - **非法 JSON 不写回** —— 用户输入到一半（`{"a":`）时若写回 undefined，
 *     配置会在用户不知情的情况下丢掉这段覆盖。所以只在解析成功时提交。
 *   - 空串 = 清除覆盖（提交 undefined），并在提示里说清这一点。
 *   - 错误就地显示，不弹窗、不阻塞其它字段。
 *
 * @param {{label:string, value?:object, hint?:string, placeholder?:string,
 *          rows?:number, open?:boolean, onCommit:(v:object|undefined)=>void}} opts
 */
function jsonEditor(opts) {
    const wrap = el('details', 'json-editor');
    const sum = document.createElement('summary');
    sum.textContent = opts.label;
    wrap.appendChild(sum);

    const inner = el('div', 'json-editor-body');
    if (opts.hint) {
        const h = el('div', 'field-note');
        h.textContent = opts.hint;
        inner.appendChild(h);
    }

    const ta = document.createElement('textarea');
    ta.className = 'json-area';
    ta.rows = opts.rows || 6;
    ta.spellcheck = false;
    ta.placeholder = opts.placeholder || '（留空 = 不覆盖，用内置默认）';
    ta.value = opts.value && Object.keys(opts.value).length ? JSON.stringify(opts.value, null, 2) : '';
    inner.appendChild(ta);

    const err = el('div', 'json-err');
    err.hidden = true;
    inner.appendChild(err);

    const commit = () => {
        const raw = ta.value.trim();
        if (!raw) {
            err.hidden = true;
            ta.classList.remove('bad');
            opts.onCommit(undefined);          // 空 = 清除覆盖
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            // 解析失败：显示错误、**不写回**，用户继续输入即可
            err.textContent = 'JSON 语法错误：' + (e && e.message ? e.message : String(e));
            err.hidden = false;
            ta.classList.add('bad');
            return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            err.textContent = '必须是一个 JSON 对象（{…}）';
            err.hidden = false;
            ta.classList.add('bad');
            return;
        }
        err.hidden = true;
        ta.classList.remove('bad');
        opts.onCommit(parsed);
    };
    // input 事件：实时反馈（但不重建面板，避免失焦）
    ta.oninput = commit;
    // 折叠时也提交一次，防止"改了但没触发 input"（如粘贴后立刻折叠）
    wrap.ontoggle = () => { if (!wrap.open) commit(); };

    if (opts.open) wrap.open = true;
    wrap.appendChild(inner);
    return wrap;
}

/**
 * 读写 `request` 下的子对象（body / response / request / params / prompt）。
 * 值空则删键、并清理空壳对象 —— 配置要保持紧凑（空对象不写进 JSON）。
 */
function reqSub(m, key) {
    const v = m.request && m.request[key];
    return v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {};
}
function setReqSub(m, key, val) {
    if (!m.request) m.request = {};
    if (val && Object.keys(val).length) m.request[key] = val;
    else delete m.request[key];
    if (Object.keys(m.request).length === 0) delete m.request;   // 全空 → 整个 request 也删掉
}

/**
 * 结构化字段行：标签 + 输入框。空串 → 删掉该键（而不是写空串）。
 * 用于 `response` 这类**字段固定**、值得结构化编辑的地方 ——
 * 比丢一个 JSON 框好用得多（用户不必知道 JSON 语法，也不会拼错键名）。
 *
 * 回调只调 onChange（内部是 renderOutput），**绝不重建面板**（会夺走焦点）。
 */
function subInput(label, value, onInput, opts = {}) {
    const row = el('div', 'sub-field');
    const lb = el('label', 'sub-label');
    lb.textContent = label;
    if (opts.title) lb.title = opts.title;
    row.appendChild(lb);

    const inp = document.createElement('input');
    inp.type = opts.type || 'text';
    inp.value = value == null ? '' : String(value);
    if (opts.placeholder) inp.placeholder = opts.placeholder;
    if (opts.title) inp.title = opts.title;
    if (opts.list) { inp.setAttribute('list', opts.list); inp.autocomplete = 'off'; inp.spellcheck = false; }
    inp.oninput = () => onInput(inp.value.trim());
    row.appendChild(inp);

    if (opts.note) {
        const n = el('div', 'sub-note');
        n.textContent = opts.note;
        row.appendChild(n);
    }
    return row;
}

/**
 * 数字字段行：**只把有限数写进配置**。
 *
 * 为什么不能直接 `Number(v)` 再写回：`Number('abc')` 是 NaN、`Number('1e999')` 是 Infinity，
 * 而 `JSON.stringify({a: NaN})` 产出的是 **null**。插件侧 `Number(null) === 0`，
 * 于是 `poll_interval` 变成 0 —— 语义是"不等待就轮询"，**会把对方接口打爆**。
 * 所以非有限值一律不写回（并标红），空值则删键。
 *
 * 与 jsonEditor 同一套约定：非法输入**不写回**，用户继续改即可，不静默丢数据。
 */
function subNumber(label, value, onSet, opts = {}) {
    const row = el('div', 'sub-field');
    const lb = el('label', 'sub-label');
    lb.textContent = label;
    if (opts.title) lb.title = opts.title;
    row.appendChild(lb);

    const inp = document.createElement('input');
    inp.type = 'number';
    inp.value = value == null || value === '' ? '' : String(value);
    if (opts.placeholder) inp.placeholder = opts.placeholder;
    if (opts.min != null) inp.min = String(opts.min);
    inp.oninput = () => {
        const raw = inp.value.trim();
        if (raw === '') { inp.classList.remove('bad'); onSet(undefined); return; }
        const n = Number(raw);
        if (!Number.isFinite(n)) { inp.classList.add('bad'); return; }   // 不写回
        inp.classList.remove('bad');
        onSet(n);
    };
    row.appendChild(inp);

    if (opts.note) {
        const n = el('div', 'sub-note');
        n.textContent = opts.note;
        row.appendChild(n);
    }
    return row;
}

/** 结构化下拉字段行（同 subInput，但选项固定） */
function subSelect(label, value, options, onChange, opts = {}) {
    const row = el('div', 'sub-field');
    const lb = el('label', 'sub-label');
    lb.textContent = label;
    if (opts.title) lb.title = opts.title;
    row.appendChild(lb);

    const sel = document.createElement('select');
    for (const [val, text, title] of options) {
        const o = document.createElement('option');
        o.value = val; o.textContent = text;
        if (title) o.title = title;
        sel.appendChild(o);
    }
    sel.value = value == null ? '' : String(value);
    sel.onchange = () => onChange(sel.value);
    row.appendChild(sel);

    if (opts.note) {
        const n = el('div', 'sub-note');
        n.textContent = opts.note;
        row.appendChild(n);
    }
    return row;
}

/**
 * 「响应格式」结构化编辑区 —— 从返回里取媒体数据（图片/音频）。
 *
 * 字段清单与插件 `media.ts` 一一对应，别漏也别编：
 *   取数：data_path（点分路径，支持数组下标）/ data_type（auto|url|base64|hex）/ error_message_path
 *   异步：task_id_path / task_status_path / success_values / failure_values
 *         poll_url / poll_interval（秒）/ poll_max
 * 默认值写在占位符里（插件的兜底：轮询 15s × 20 次，成功 SUCCEEDED/SUCCESS/COMPLETED）。
 */
function responseEditor(m, onChange) {
    const resp = reqSub(m, 'response');
    const commit = () => { setReqSub(m, 'response', resp); onChange(); };

    const wrap = el('details', 'json-editor sub-editor');
    const sum = document.createElement('summary');
    sum.textContent = '响应格式' + (Object.keys(resp).length ? '（已设置）' : '');
    wrap.appendChild(sum);

    const body = el('div', 'json-editor-body');
    const note = el('div', 'field-note');
    note.textContent = '从返回里取媒体数据。同步接口只填「取数」；'
        + '返回任务号需要轮询的（wanx 异步、腾讯等）再填「异步任务轮询」。留空 = 用内置预设。';
    body.appendChild(note);

    const set = (k, v) => {
        if (v === '' || v == null) delete resp[k]; else resp[k] = v;
        commit();
    };
    const setList = (k, raw) => {
        const arr = String(raw).split(',').map(x => x.trim()).filter(Boolean);
        if (arr.length) resp[k] = arr; else delete resp[k];
        commit();
    };
    const listText = (k) => Array.isArray(resp[k]) ? resp[k].join(', ') : '';

    // ---- 取数（同步）
    body.appendChild(subInput('取数路径 data_path', resp.data_path, (v) => set('data_path', v), {
        placeholder: '如 output.choices.0.message.content.0.image',
        note: '点分路径，支持数组下标。写错了会报"未找到图片/音频数据"。',
    }));
    body.appendChild(subSelect('数据类型 data_type', resp.data_type || '', [
        ['', '自动（默认）', '按响应内容判断：JSON 走取数路径，其余当二进制'],
        ['url', 'url', '取到的是图片/音频地址'],
        ['base64', 'base64', '取到的是 base64 文本'],
        ['hex', 'hex', '取到的是十六进制文本（会自动转 base64）'],
    ], (v) => set('data_type', v), {
        note: '未写 data_path 时：base64/hex 表示"整个响应体就是数据"（如 TTS 音频流）。',
    }));
    body.appendChild(subInput('错误信息路径 error_message_path', resp.error_message_path, (v) => set('error_message_path', v), {
        placeholder: '如 error.message',
        note: '接口失败时从这里取错误文案，比 HTTP 状态码更有用。',
    }));

    // ---- 异步任务轮询（子折叠）
    const poll = el('details', 'json-editor sub-editor');
    const psum = document.createElement('summary');
    const pollKeys = ['task_id_path', 'task_status_path', 'poll_url', 'poll_interval', 'poll_max', 'success_values', 'failure_values'];
    const pollSet = pollKeys.filter(k => resp[k] !== undefined).length;
    psum.textContent = '异步任务轮询' + (pollSet ? `（已设置 ${pollSet} 项）` : '');
    poll.appendChild(psum);
    const pbody = el('div', 'json-editor-body');
    const pnote = el('div', 'field-note');
    pnote.textContent = '接口先返回任务号、之后要轮询取结果的（如百炼 wanx 异步生图）才需要。'
        + '只填 task_id_path + poll_url 就会启用。';
    pbody.appendChild(pnote);

    pbody.appendChild(subInput('任务号路径 task_id_path', resp.task_id_path, (v) => set('task_id_path', v), {
        placeholder: '如 output.task_id',
        note: '取到任务号才会启动轮询。',
    }));
    pbody.appendChild(subInput('状态路径 task_status_path', resp.task_status_path, (v) => set('task_status_path', v), {
        placeholder: '如 output.task_status',
    }));
    pbody.appendChild(subInput('轮询地址 poll_url', resp.poll_url, (v) => set('poll_url', v), {
        placeholder: '如 https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}',
        note: '支持 {task_id} 占位符。',
    }));
    pbody.appendChild(subNumber('轮询间隔（秒）poll_interval', resp.poll_interval, (v) => set('poll_interval', v), {
        min: 0, placeholder: '15（默认）',
        note: '0 表示不等待就轮询 —— 除非确知接口是同步返回，否则别填 0。',
    }));
    pbody.appendChild(subNumber('最多轮询次数 poll_max', resp.poll_max, (v) => set('poll_max', v), {
        min: 1, placeholder: '20（默认）',
    }));
    pbody.appendChild(subInput('成功状态值 success_values', listText('success_values'), (v) => setList('success_values', v), {
        placeholder: 'SUCCEEDED, SUCCESS, COMPLETED（默认）',
        note: '逗号分隔，大小写不敏感。',
    }));
    pbody.appendChild(subInput('失败状态值 failure_values', listText('failure_values'), (v) => setList('failure_values', v), {
        placeholder: 'FAILED, ERROR, CANCELED（默认）',
        note: '逗号分隔，大小写不敏感。',
    }));

    poll.appendChild(pbody);
    if (pollSet) poll.open = true;
    body.appendChild(poll);

    wrap.appendChild(body);
    // 与 body 一样默认展开：用户点开「请求与响应格式」多半就是要改这两项之一
    wrap.open = true;
    return wrap;
}

// ---------------------------------------------------------------- 事件

$('copyBtn').onclick = async () => {
    const cfg = build(state.providers, state.purposes, state.useBodies, state.extraGroups);
    const text = $('maskKey').checked ? serialize(maskKeys(cfg)) : serialize(cfg);
    try {
        await navigator.clipboard.writeText(text);
        toast('已复制，粘到 模型 → 模型配置', 'ok');
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('已复制', 'ok'); }
        catch { toast('复制失败，请手动选中预览内容', 'err'); }
        document.body.removeChild(ta);
    }
};

$('downloadBtn').onclick = () => {
    const cfg = build(state.providers, state.purposes, state.useBodies, state.extraGroups);
    const text = $('maskKey').checked ? serialize(maskKeys(cfg)) : serialize(cfg);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aiplugin4-model-config.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

$('clearBtn').onclick = () => {
    if (state.providers.length && !confirm('清空全部连接？')) return;
    state = { providers: [], purposes: {}, useBodies: {}, extraGroups: [] };
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    renderAll();
};

// 「恢复默认」：用出厂示例替换当前内容。
//
// 与「清空」的区别（两个都要有，语义不同）：
//   清空     → 完全空的配置，从零开始搭
//   恢复默认 → 出厂示例（DeepSeek + flash/pro），用来对照/回退到已知可用状态
//
// 存在意义之一：草稿会自动存 localStorage，刷新加载的是**存档**而不是出厂示例，
// 所以改了出厂示例后光刷新是看不到效果的 —— 得有这个按钮。
$('resetBtn').onclick = () => {
    if (state.providers.length
        && !confirm('恢复出厂示例？\n当前的连接、模型与用途绑定都会被替换。')) return;
    state = factoryState();
    scheduleSave();   // 落盘：否则刷新又会回到旧存档
    renderAll();
    toast('已恢复出厂示例：DeepSeek + deepseek-flash / deepseek-pro', 'ok');
};

$('maskKey').onchange = renderOutput;
$('panelClose').onclick = closePanel;
$('panelCancel').onclick = closePanel;
$('panelSave').onclick = savePanel;
$('panelBackdrop').onclick = closePanel;

// ---------------------------------------------------------------- 导入
//
// 导入是导出的逆（见 v5.js 的 parseImport）。两条硬约定：
//   1. **校验不通过就不改动任何东西** —— 用户粘错内容时不能把现有配置毁掉
//   2. 校验通过但有"表达不出来"的部分（非标准用途组）时，**照常导入 + 明确警告**，
//      不能静默丢内容

function openImport() {
    $('importText').value = '';
    $('importMsg').hidden = true;
    $('importMsg').textContent = '';
    $('importWarn').hidden = true;
    $('importWarn').textContent = '';
    $('importPanel').hidden = false;
    $('importBackdrop').hidden = false;
    $('importText').focus();
}

function closeImport() {
    $('importPanel').hidden = true;
    $('importBackdrop').hidden = true;
    // 与连接面板同理：清空内容，避免关闭后残留 DOM 被选择器命中
    $('importText').value = '';
    $('importMsg').hidden = true;
    $('importWarn').hidden = true;
}

function showImportError(issues) {
    const box = $('importMsg');
    const lines = issues.slice(0, 8).map(i => `${i.path} ${i.msg}`);
    if (issues.length > 8) lines.push(`…还有 ${issues.length - 8} 处`);
    box.textContent = '导入失败，未改动任何内容：\n' + lines.join('\n');
    box.hidden = false;
    $('importWarn').hidden = true;
}

function doImport() {
    const res = parseImport($('importText').value);
    if (!res.ok) {
        showImportError(res.issues);
        return;
    }
    // 先关掉连接编辑面板：它的草稿属于**导入前**的 state。
    // 不关的话 renderOutput() 走 effectiveProviders() 会优先用草稿，
    // 于是预览显示的是"旧连接 + 草稿改动"而不是刚导入的配置 —— 用户看到的是个混合体。
    closePanel();
    const s = res.state;
    // 补 UI 概念字段（uid / templateId / mode）——它们不进配置，只服务界面
    state = {
        providers: s.providers.map(p => {
            const templateId = templateIdForBaseUrl(p.baseURL, p.api);
            return {
                ...p,
                uid: nextUid(),
                templateId,
                mode: templateId === 'custom' ? 'custom' : 'vendor',
            };
        }),
        purposes: s.purposes,
        useBodies: s.useBodies,
        extraGroups: s.extraGroups,
    };
    scheduleSave();
    renderAll();
    closeImport();

    if (res.warnings.length) {
        // 导入已完成，但要让用户知道哪部分没能进界面
        const box = $('validationBox');
        box.hidden = false;
        box.innerHTML = '';
        const t = el('div', 'import-warn');
        t.textContent = '已导入，但有需要注意的地方：';
        const ul = document.createElement('ul');
        for (const w of res.warnings) {
            const li = document.createElement('li');
            li.textContent = w;
            ul.appendChild(li);
        }
        t.appendChild(ul);
        box.appendChild(t);
    }
}

$('importBtn').onclick = openImport;
$('importClose').onclick = closeImport;
$('importCancel').onclick = closeImport;
$('importBackdrop').onclick = closeImport;
$('importConfirm').onclick = doImport;

// ---------------------------------------------------------------- 启动

/**
 * 出厂示例状态 —— **唯一的定义处**。
 *
 * 启动时（没有存档）与「恢复默认」按钮都调它。抽成函数是为了不让两处漂移：
 * 之前这个对象只写在启动分支里，想"看修改效果"就只能手动清 localStorage。
 *
 * 与**插件的出厂默认**（`src/config/v5/default.ts`）保持一致：
 * 一条 DeepSeek 连接 + 两个模型（flash=vision / pro=text）+ 四个对话类用途全绑 flash。
 *
 * 模型**显式声明 kind**：插件侧视觉已不再靠命名猜测（catalog.ts 删掉了
 * GENERIC_VISION_PATTERNS），不声明就只能指望接口自报能力位，而模型列表拉取失败
 * （CORS/离线/对方不报）时 flash 会掉成 text、视觉能力直接没了。
 */
function factoryState() {
    const tpl = getTemplate('deepseek');
    return {
        providers: [{
            uid: nextUid(), templateId: 'deepseek', mode: 'vendor',
            provider: '', api: tpl.api, baseURL: tpl.baseUrl, apiKey: '',
            models: [
                { id: 'flash', name: 'deepseek-flash', kind: 'vision' },
                { id: 'pro', name: 'deepseek-pro', kind: 'text' },
            ],
            enabled: true, displayName: '', timeout: 0, request: {},
        }],
        purposes: { chat: ['flash'], compression: ['flash'], summarization: ['flash'], judge: ['flash'] },
        useBodies: {},
        extraGroups: [],
    };
}

const saved = loadDraft();
if (saved) {
    state = saved;
    // 立即回写一次：把加载时补的 UI 字段（uid/templateId/mode）落盘
    scheduleSave();
} else {
    state = factoryState();
}
renderAll();

// ---------------------------------------------------------------- 版本自检
//
// 为什么需要：GitHub Pages 固定发 `Cache-Control: max-age=600`（HTML 与 JS 都是），
// 而且 **Pages 不支持自定义响应头**（没有 Netlify/Cloudflare 那种 `_headers`）。
// 于是部署后最多 10 分钟内浏览器可能仍在跑旧文件 —— 表现为"我明明改了它却没生效"，
// 极难排查（本项目在本地服务和 Pages 上各踩过一次，都是 Ctrl+F5 才发现）。
//
// 根治思路：让**页面自己发现自己是旧的**。
//   1. 取一份**绕过缓存**的自身副本（cache: 'no-store'）
//   2. 与浏览器**当前正在运行的**那份（cache: 'only-if-cached'）比对
//   3. 不一致 → 顶部出一条"有新版本"，点一下带 ?v= 重载
//
// 关键：这个检查由**旧页面**发起也能发现新版本，所以缓存挡不住它。
//
// 「立即刷新」为什么要带 ?v=：实测 `location.reload()` 和
// `location.replace(url + '?_=' + now)` **都只能刷到新 HTML，子资源仍走缓存**，
// 提示会一直在（只有 Ctrl+F5 会全绕开）。所以 index.html 里有段解析期脚本
// 把 ?v= 透传给 CSS/JS 的 URL，让三者**一起**换成新 URL。
//
// 任何一步失败都**静默跳过**：这只是便利提示，不能因检查失败影响正常使用。
async function checkForNewerVersion() {
    try {
        const url = import.meta.url;
        const [running, latest] = await Promise.all([
            // 浏览器当前手上那份（就是它刚执行的那份）
            fetch(url, { cache: 'only-if-cached', mode: 'same-origin' }).then((r) => r.text()),
            // 服务器上那份（绕过一切缓存）
            fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' }).then((r) => r.text()),
        ]);
        if (running === latest) return;
        showUpdateBanner();
    } catch {
        /* only-if-cached 不被支持 / 离线 / 跨源 —— 静默跳过 */
    }
}

function showUpdateBanner() {
    if ($('updateBar')) return;
    const bar = el('div', 'update-bar');
    bar.id = 'updateBar';
    const txt = el('span', 'update-text');
    txt.textContent = '页面有更新（当前是浏览器缓存的旧版）';
    bar.appendChild(txt);
    const btn = el('button', 'btn btn-sm btn-primary');
    btn.type = 'button';
    btn.textContent = '立即刷新';
    btn.onclick = () => {
        const u = new URL(location.href);
        u.searchParams.set('v', String(Date.now()));
        location.replace(u.toString());
    };
    bar.appendChild(btn);
    document.body.appendChild(bar);
}

checkForNewerVersion();
