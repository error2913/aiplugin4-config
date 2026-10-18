// 联网搜索配置分区：provider 卡片 + 内联编辑 + 输出「联网配置」JSON。
// 纯逻辑在 web.js（可单测），本文件只做 DOM 与交互。
import {
    WEB_DEFAULTS, WEB_DETAILS, WEB_DIALECTS, WEB_PRESETS,
    DEFAULT_GENERIC_SEARCH, DEFAULT_GENERIC_FETCH,
    presetOf, makeProvider, normalizeDefaults, supportsFetch,
    validateWeb, buildWeb, serializeWeb, maskWebKeys, parseWebImport,
} from './web.js';

const STORAGE_KEY = 'aiplugin4-config-web-draft';

// ---------------------------------------------------------------- 状态

let uidSeq = 0;
const nextUid = () => `w${++uidSeq}-${Math.random().toString(36).slice(2, 7)}`;

let state = {
    providers: [],
    defaults: { ...WEB_DEFAULTS },
};
/** 当前展开编辑的 provider uid（同一时间只展开一个） */
let editingUid = null;
let saveTimer = null;

function defaultState() {
    const deepseek = makeProvider('deepseek', nextUid());
    const searxng = makeProvider('searxng', nextUid());
    return {
        providers: [deepseek, searxng],
        defaults: { ...WEB_DEFAULTS },
    };
}

// ---------------------------------------------------------------- 持久化

function normalizeStored(p) {
    const dialect = WEB_PRESETS[p.dialect] ? p.dialect : 'generic';
    const preset = presetOf(dialect);
    return {
        uid: nextUid(),
        id: typeof p.id === 'string' && p.id ? p.id : dialect,
        dialect,
        baseURL: typeof p.baseURL === 'string' ? p.baseURL : (preset.baseURL || ''),
        apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
        enabled: p.enabled !== false,
        timeout: p.timeout !== undefined && p.timeout !== null ? String(p.timeout) : '',
        headers: typeof p.headers === 'string' ? p.headers : '',
        searchJson: typeof p.searchJson === 'string' ? p.searchJson : '',
        fetchJson: typeof p.fetchJson === 'string' ? p.fetchJson : '',
    };
}

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const d = JSON.parse(raw);
        if (!d || !Array.isArray(d.providers) || d.providers.length === 0) return null;
        return {
            providers: d.providers.map(normalizeStored),
            defaults: normalizeDefaults(d.defaults || {}),
        };
    } catch {
        return null;
    }
}

function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                providers: state.providers,
                defaults: state.defaults,
            }));
        } catch (e) {
            console.warn('联网配置草稿保存失败（浏览器存储不可用或已满）：', e);
            toast('浏览器存储不可用，配置不会自动保存（刷新会丢）', 'err');
        }
    }, 300);
}

// ---------------------------------------------------------------- 工具

const $ = (id) => document.getElementById(id);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

function toast(msg, kind = '') {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast ' + kind;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { t.hidden = true; }, 2600);
}

function hostOf(url) {
    try { return new URL(String(url || '')).hostname.toLowerCase(); } catch { return ''; }
}

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

function textInput(value, onInput, placeholder) {
    const i = el('input');
    i.type = 'text';
    i.value = value === undefined || value === null ? '' : String(value);
    if (placeholder) i.placeholder = placeholder;
    i.addEventListener('input', () => onInput(i.value));
    return i;
}

function numberInput(value, onInput, placeholder, min, max) {
    const i = el('input');
    i.type = 'number';
    if (min !== undefined) i.min = String(min);
    if (max !== undefined) i.max = String(max);
    i.value = value === undefined || value === null ? '' : String(value);
    if (placeholder) i.placeholder = placeholder;
    i.addEventListener('input', () => onInput(i.value));
    return i;
}

function selectInput(value, options, onChange) {
    const s = el('select');
    for (const opt of options) {
        const o = el('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === value) o.selected = true;
        s.appendChild(o);
    }
    s.addEventListener('change', () => onChange(s.value));
    return s;
}

function textarea(value, onInput, rows = 6, placeholder) {
    const t = el('textarea', 'json-area');
    t.rows = rows;
    t.spellcheck = false;
    t.value = value === undefined || value === null ? '' : String(value);
    if (placeholder) t.placeholder = placeholder;
    t.addEventListener('input', () => onInput(t.value));
    return t;
}

function btn(label, onClick, extra = '') {
    const b = el('button', `btn btn-sm ${extra}`.trim());
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
}

// ---------------------------------------------------------------- provider 卡片

function uniqueId(dialect, self) {
    const used = new Set(state.providers.filter(x => x !== self).map(x => x.id).filter(Boolean));
    if (!used.has(dialect)) return dialect;
    for (let i = 2; ; i++) {
        if (!used.has(`${dialect}-${i}`)) return `${dialect}-${i}`;
    }
}

function applyDialect(p, dialect) {
    const oldPreset = presetOf(p.dialect);
    p.dialect = dialect;
    const preset = presetOf(dialect);
    const base = String(p.baseURL || '').trim();
    if (!base || base === oldPreset.baseURL) p.baseURL = preset.baseURL || '';
    p.id = uniqueId(dialect, p);
    if (dialect === 'generic') {
        if (!String(p.searchJson || '').trim()) p.searchJson = JSON.stringify(DEFAULT_GENERIC_SEARCH, null, 2);
        if (!String(p.fetchJson || '').trim()) p.fetchJson = JSON.stringify(DEFAULT_GENERIC_FETCH, null, 2);
    }
}

function moveProvider(index, delta) {
    const j = index + delta;
    if (j < 0 || j >= state.providers.length) return;
    const [p] = state.providers.splice(index, 1);
    state.providers.splice(j, 0, p);
    save();
    renderProviders();
    renderOutput();
}

function providerCard(p, index) {
    const preset = presetOf(p.dialect);
    const card = el('div', 'pcard web-pcard' + (editingUid === p.uid ? ' editing' : ''));

    const head = el('div', 'pcard-head');
    const titleWrap = el('span', 'web-title');
    titleWrap.appendChild(Object.assign(el('span', 'pcard-title'), { textContent: preset.label }));
    titleWrap.appendChild(Object.assign(el('span', 'pcard-id'), { textContent: p.id }));
    const toggle = el('label', 'toggle');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = p.enabled !== false;
    cb.addEventListener('change', () => {
        p.enabled = cb.checked;
        save();
        renderProviders();
        renderOutput();
    });
    toggle.appendChild(cb);
    toggle.appendChild(document.createTextNode('启用'));
    head.appendChild(titleWrap);
    head.appendChild(toggle);
    card.appendChild(head);

    const meta = el('div', 'web-meta');
    meta.appendChild(Object.assign(el('span'), { textContent: hostOf(p.baseURL) || '（未填 baseURL）' }));
    const keyTag = el('span', 'web-tag' + (p.apiKey || !preset.needKey ? ' on' : ''));
    keyTag.textContent = p.apiKey ? 'Key 已填' : (preset.needKey ? 'Key 未填' : '无需 Key');
    meta.appendChild(keyTag);
    meta.appendChild(Object.assign(el('span', 'web-tag on'), { textContent: '搜索' }));
    if (supportsFetch(p)) meta.appendChild(Object.assign(el('span', 'web-tag on'), { textContent: '抓取' }));
    card.appendChild(meta);

    const actions = el('div', 'pcard-actions');
    actions.appendChild(btn(editingUid === p.uid ? '收起' : '编辑', () => {
        editingUid = editingUid === p.uid ? null : p.uid;
        renderProviders();
    }));
    const up = btn('↑', () => moveProvider(index, -1), 'btn-move');
    up.disabled = index === 0;
    const down = btn('↓', () => moveProvider(index, 1), 'btn-move');
    down.disabled = index === state.providers.length - 1;
    actions.appendChild(up);
    actions.appendChild(down);
    actions.appendChild(btn('删除', () => {
        state.providers.splice(index, 1);
        if (editingUid === p.uid) editingUid = null;
        save();
        renderProviders();
        renderOutput();
    }, 'btn-danger'));
    card.appendChild(actions);

    if (editingUid === p.uid) card.appendChild(providerEdit(p));
    return card;
}

function providerEdit(p) {
    const preset = presetOf(p.dialect);
    const box = el('div', 'web-edit');

    box.appendChild(field('接入方式',
        selectInput(p.dialect, WEB_DIALECTS.map(d => ({ value: d, label: WEB_PRESETS[d].label })), v => {
            applyDialect(p, v);
            save();
            renderProviders();
            renderOutput();
        }),
        preset.hint));

    box.appendChild(field('baseURL',
        textInput(p.baseURL, v => {
            p.baseURL = v;
            save();
            renderOutput();
        }, 'https://…'),
        '留空用方言内置地址（generic 必填）'));

    box.appendChild(field('API Key',
        textInput(p.apiKey, v => {
            p.apiKey = v;
            save();
            renderOutput();
        }, preset.needKey ? 'sk-…' : '该方言不需要 Key'),
        '只保存在本机浏览器 localStorage，不会上传'));

    if (p.dialect === 'generic') {
        box.appendChild(field('search 描述（JSON）',
            textarea(p.searchJson, v => {
                p.searchJson = v;
                save();
                renderOutput();
            }, 8, '{\n  "method": "POST",\n  "path": "/v1/search",\n  "body": { "q": "{query}", "limit": "{count}" },\n  "results_path": "data.items",\n  "fields": { "title": "name", "url": "link", "snippet": "description" }\n}'),
            '占位符：{query} {count} {need_content} {page} {offset} {site} {time_range} {apiKey} {baseURL}'));
        box.appendChild(field('fetch 描述（JSON）',
            textarea(p.fetchJson, v => {
                p.fetchJson = v;
                save();
                renderOutput();
            }, 6, '{\n  "method": "GET",\n  "path": "/reader?url={url}",\n  "response_type": "json",\n  "title_path": "title",\n  "content_path": "content"\n}'),
            'response_type：json | text；留空 = 该 provider 不参与抓取'));
    }

    const adv = el('details', 'json-editor');
    adv.appendChild(Object.assign(el('summary'), { textContent: '高级（超时 / 额外请求头）' }));
    const advBody = el('div', 'json-editor-body');
    advBody.appendChild(field('超时（秒）',
        numberInput(p.timeout, v => {
            p.timeout = v;
            save();
            renderOutput();
        }, '留空用默认项', 1),
        '覆盖「默认项」里的 timeout'));
    advBody.appendChild(field('额外 headers（JSON）',
        textarea(p.headers, v => {
            p.headers = v;
            save();
            renderOutput();
        }, 3, '{ "X-Trace-Id": "1" }'),
        '必须是 JSON 对象；留空不写'));
    adv.appendChild(advBody);
    box.appendChild(adv);

    return box;
}

function renderProviders() {
    const wrap = $('webProviderList');
    if (!wrap) return;
    wrap.innerHTML = '';
    state.providers.forEach((p, i) => wrap.appendChild(providerCard(p, i)));

    const add = el('button', 'pcard pcard-add');
    add.type = 'button';
    add.textContent = '+ 添加 provider';
    add.addEventListener('click', () => {
        const p = makeProvider('deepseek', nextUid());
        p.id = uniqueId('deepseek', p);
        state.providers.push(p);
        editingUid = p.uid;
        save();
        renderAll();
    });
    wrap.appendChild(add);
}

// ---------------------------------------------------------------- 默认项

function renderDefaults() {
    const wrap = $('webDefaults');
    if (!wrap) return;
    wrap.innerHTML = '';

    wrap.appendChild(field('返回条数 count',
        numberInput(state.defaults.count, v => {
            state.defaults.count = v === '' ? '' : Number(v);
            save();
            renderOutput();
        }, '10', 1, 50),
        '1~50，工具未指定时使用'));

    wrap.appendChild(field('detail 详细程度',
        selectInput(state.defaults.detail, WEB_DETAILS.map(d => ({ value: d, label: d })), v => {
            state.defaults.detail = v;
            save();
            renderOutput();
        }),
        'snippet 短摘要 / summary 长摘要 / content 正文'));

    wrap.appendChild(field('超时 timeout（秒）',
        numberInput(state.defaults.timeout, v => {
            state.defaults.timeout = v === '' ? '' : Number(v);
            save();
            renderOutput();
        }, '20', 1),
        '单次请求超时'));

    wrap.appendChild(field('正文截断 maxContentChars',
        numberInput(state.defaults.maxContentChars, v => {
            state.defaults.maxContentChars = v === '' ? '' : Number(v);
            save();
            renderOutput();
        }, '5000', 100),
        'detail=content 时单条正文的最大字符数'));

    const fb = el('label', 'toggle');
    const fbc = el('input');
    fbc.type = 'checkbox';
    fbc.checked = state.defaults.fallback !== false;
    fbc.addEventListener('change', () => {
        state.defaults.fallback = fbc.checked;
        save();
        renderOutput();
    });
    fb.appendChild(fbc);
    fb.appendChild(document.createTextNode('失败自动换下一个 provider'));
    wrap.appendChild(field('fallback', fb, '关闭后只试第一个，排障用'));
}

// ---------------------------------------------------------------- 输出

function renderOutput() {
    if (!$('webPreview')) return;
    const masked = $('webMaskKey').checked;
    const pretty = $('webPrettyJson').checked;
    const { problems, warnings } = validateWeb(state.providers, state.defaults);
    let cfg = buildWeb(state.providers, state.defaults);
    if (masked) cfg = maskWebKeys(cfg);
    $('webPreview').textContent = serializeWeb(cfg, pretty);

    const box = $('webValidation');
    box.innerHTML = '';
    if (problems.length === 0 && warnings.length === 0) {
        box.hidden = true;
    } else {
        box.hidden = false;
        if (problems.length > 0) {
            const t = el('div', 'vtitle');
            t.textContent = `配置有 ${problems.length} 处问题，修正后才能复制：`;
            box.appendChild(t);
            box.appendChild(issueList(problems));
        }
        if (warnings.length > 0) {
            const t = el('div', 'vtitle warn');
            t.textContent = `提示（不影响复制）：${warnings.length} 条`;
            box.appendChild(t);
            box.appendChild(issueList(warnings));
        }
    }
    $('webCopyBtn').disabled = problems.length > 0;
}

function issueList(issues) {
    const ul = el('ul');
    for (const p of issues) {
        const li = el('li');
        const code = el('code');
        code.textContent = p.path;
        li.appendChild(code);
        li.appendChild(document.createTextNode(' ' + p.msg));
        ul.appendChild(li);
    }
    return ul;
}

function renderAll() {
    renderProviders();
    renderDefaults();
    renderOutput();
}

// ---------------------------------------------------------------- 导入 / 导出

function openImport(open) {
    $('webImportBox').hidden = !open;
    $('webImportMsg').hidden = true;
    if (open) $('webImportText').focus();
}

function doImport() {
    const msg = $('webImportMsg');
    try {
        const imported = parseWebImport($('webImportText').value);
        const { problems } = validateWeb(imported.providers, imported.defaults);
        if (problems.length > 0) {
            msg.hidden = false;
            msg.textContent = problems.map(p => `${p.path} ${p.msg}`).join('\n');
            return;
        }
        state.providers = imported.providers;
        state.defaults = imported.defaults;
        editingUid = null;
        save();
        renderAll();
        openImport(false);
        toast('已导入联网配置', 'ok');
    } catch (e) {
        msg.hidden = false;
        msg.textContent = e instanceof Error ? e.message : String(e);
    }
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch { /* 走下面的兜底 */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
}

// ---------------------------------------------------------------- 分区切换

function setView(view) {
    const isWeb = view === 'web';
    const model = $('modelLayout');
    const web = $('webLayout');
    if (!model || !web) return;
    model.hidden = isWeb;
    web.hidden = !isWeb;
    const tm = $('tabModel');
    const tw = $('tabWeb');
    if (tm) {
        tm.classList.toggle('active', !isWeb);
        tm.setAttribute('aria-selected', String(!isWeb));
    }
    if (tw) {
        tw.classList.toggle('active', isWeb);
        tw.setAttribute('aria-selected', String(isWeb));
    }
    if (isWeb) renderAll();
}

// ---------------------------------------------------------------- 启动

function init() {
    const loaded = loadState();
    state = loaded || defaultState();
    editingUid = null;

    $('webMaskKey').addEventListener('change', renderOutput);
    $('webPrettyJson').addEventListener('change', renderOutput);

    $('webCopyBtn').addEventListener('click', async () => {
        const ok = await copyText($('webPreview').textContent);
        toast(ok ? '已复制，去「联网 → 联网配置」粘贴' : '复制失败，请手动全选复制', ok ? 'ok' : 'err');
    });

    $('webDownloadBtn').addEventListener('click', () => {
        const blob = new Blob([$('webPreview').textContent], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'aiplugin4-联网配置.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    $('webImportBtn').addEventListener('click', () => openImport($('webImportBox').hidden));
    $('webImportCancel').addEventListener('click', () => openImport(false));
    $('webImportConfirm').addEventListener('click', doImport);

    $('webResetBtn').addEventListener('click', () => {
        state = defaultState();
        editingUid = null;
        save();
        renderAll();
        toast('已恢复 DeepSeek + SearXNG 示例', 'ok');
    });

    $('webClearBtn').addEventListener('click', () => {
        state.providers = [];
        state.defaults = { ...WEB_DEFAULTS };
        editingUid = null;
        save();
        renderAll();
    });

    $('tabModel').addEventListener('click', () => setView('model'));
    $('tabWeb').addEventListener('click', () => setView('web'));

    const params = new URLSearchParams(location.search);
    const wantWeb = params.get('tab') === 'web' || location.hash === '#web';
    setView(wantWeb ? 'web' : 'model');
}

init();
