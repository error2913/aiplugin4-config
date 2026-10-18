// 联网搜索配置分区：provider 卡片 + 内联编辑 + 输出「联网配置」JSON。
// 纯逻辑在 web.js（可单测），本文件只做 DOM 与交互。
import {
    WEB_DIALECTS, WEB_PRESETS,
    DEFAULT_GENERIC_SEARCH, DEFAULT_GENERIC_FETCH,
    presetOf, makeProvider, supportsFetch,
    validateWeb, buildWeb, serializeWeb, maskWebKeys, parseWebImport,
} from './web.js';
import { initTabs, registerView } from './tabs.js';
import {
    apiKeyInput, cardActions, copyText, openImportDialog, openSideEditor, pickFiles, readFileText,
} from './ui.js';

const STORAGE_KEY = 'aiplugin4-config-web-draft';

// ---------------------------------------------------------------- 状态

let uidSeq = 0;
const nextUid = () => `w${++uidSeq}-${Math.random().toString(36).slice(2, 7)}`;

let state = {
    providers: [],
};
let saveTimer = null;

function defaultState() {
    const deepseek = makeProvider('deepseek', nextUid());
    const searxng = makeProvider('searxng', nextUid());
    return { providers: [deepseek, searxng] };
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
        return { providers: d.providers.map(normalizeStored) };
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
    const card = el('div', 'pcard web-pcard');

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

    card.appendChild(cardActions({
        canUp: index > 0,
        canDown: index < state.providers.length - 1,
        onUp: () => moveProvider(index, -1),
        onDown: () => moveProvider(index, 1),
        onEdit: () => openWebEditor(index),
        onDelete: () => {
            state.providers.splice(index, 1);
            save();
            renderProviders();
            renderOutput();
        },
    }));

    return card;
}

/** 联网 Provider 的编辑统一走右侧面板（与模型 / 内容分区一致） */
function openWebEditor(index) {
    const original = JSON.parse(JSON.stringify(state.providers[index]));
    const body = el('div', 'side-editor');
    const render = () => {
        body.innerHTML = '';
        body.appendChild(providerEdit(
            state.providers[index],
            () => { save(); renderOutput(); },
            () => { save(); render(); renderOutput(); },
        ));
    };
    render();
    openSideEditor({
        title: '编辑联网 Provider',
        body,
        onSave: () => { save(); renderAll(); },
        onCancel: () => {
            state.providers[index] = original;
            save();
            renderAll();
        },
    });
}

/**
 * 编辑表单：只负责改字段，不负责保存时机。
 * @param {object} p Provider（直接改 state 里的对象；取消时由 openWebEditor 回滚）
 * @param {() => void} onChange 普通字段变化（刷新预览）
 * @param {() => void} onRestructure 接入方式变化（需要重建表单）
 */
function providerEdit(p, onChange, onRestructure) {
    const preset = presetOf(p.dialect);
    const box = el('div', 'web-edit');

    box.appendChild(field('接入方式',
        selectInput(p.dialect, WEB_DIALECTS.map(d => ({ value: d, label: WEB_PRESETS[d].label })), v => {
            applyDialect(p, v);
            onRestructure();
        }),
        preset.hint));

    box.appendChild(field('baseURL',
        textInput(p.baseURL, v => {
            p.baseURL = v;
            onChange();
        }, 'https://…'),
        '留空用方言内置地址（generic 必填）'));

    box.appendChild(field('API Key',
        apiKeyInput(p.apiKey, v => {
            p.apiKey = v;
            onChange();
        }, { placeholder: preset.needKey ? 'sk-…' : '该方言不需要 Key' }),
        '明文存入生成的配置；只保存在本机浏览器 localStorage，不会上传。分享时请用「遮蔽」'));

    if (p.dialect === 'generic') {
        box.appendChild(field('search 描述（JSON）',
            textarea(p.searchJson, v => {
                p.searchJson = v;
                onChange();
            }, 8, '{\n  "method": "POST",\n  "path": "/v1/search",\n  "body": { "q": "{query}", "limit": "{count}" },\n  "results_path": "data.items",\n  "fields": { "title": "name", "url": "link", "snippet": "description" }\n}'),
            '占位符：{query} {count} {need_content} {page} {offset} {site} {time_range} {apiKey} {baseURL}'));
        box.appendChild(field('fetch 描述（JSON）',
            textarea(p.fetchJson, v => {
                p.fetchJson = v;
                onChange();
            }, 6, '{\n  "method": "GET",\n  "path": "/reader?url={url}",\n  "response_type": "json",\n  "title_path": "title",\n  "content_path": "content"\n}'),
            'response_type：json | text；留空 = 该 provider 不参与抓取'));
    }

    const adv = el('details', 'json-editor');
    adv.appendChild(Object.assign(el('summary'), { textContent: '高级（超时 / 额外请求头）' }));
    const advBody = el('div', 'json-editor-body');
    advBody.appendChild(field('超时（秒）',
        numberInput(p.timeout, v => {
            p.timeout = v;
            onChange();
        }, '留空用插件配置项', 1),
        '覆盖「联网搜索超时」配置项'));
    advBody.appendChild(field('额外 headers（JSON）',
        textarea(p.headers, v => {
            p.headers = v;
            onChange();
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
        save();
        renderAll();
        openWebEditor(state.providers.length - 1);
    });
    wrap.appendChild(add);
}

// ---------------------------------------------------------------- 输出

function renderOutput() {
    if (!$('webPreview')) return;
    const masked = $('webMaskKey').checked;
    const pretty = $('webPrettyJson').checked;
    const { problems, warnings } = validateWeb(state.providers);
    let cfg = buildWeb(state.providers);
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
    renderOutput();
}

// ---------------------------------------------------------------- 导入 / 导出

/** 统一导入对话框的 parse 适配：parseWebImport 用抛错表达失败，这里转成 issues */
function parseWebForDialog(text) {
    try {
        const imported = parseWebImport(text);
        const { problems } = validateWeb(imported.providers);
        if (problems.length > 0) return { ok: false, issues: problems };
        return { ok: true, value: imported };
    } catch (e) {
        return { ok: false, issues: [{ path: '$', msg: e instanceof Error ? e.message : String(e) }] };
    }
}

function applyWebImport(imported) {
    state.providers = imported.providers;
    save();
    renderAll();
    toast('已导入联网配置', 'ok');
}

function openImport() {
    openImportDialog({
        title: '导入联网配置',
        hint: '粘贴一份已有的「联网配置」。导入会替换当前内容；校验不通过时不会改动任何东西。',
        placeholder: '{"providers":[{"dialect":"deepseek","apiKey":"sk-…"}]}',
        rows: 10,
        parse: parseWebForDialog,
        onSuccess: (res) => applyWebImport(res.value),
    });
}

// ---------------------------------------------------------------- 启动

function init() {
    const loaded = loadState();
    state = loaded || defaultState();

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

    $('webImportBtn').addEventListener('click', openImport);
    $('webFileImportBtn').addEventListener('click', () => pickFiles({
        accept: '.json',
        onFiles: (files) => {
            readFileText(files[0]).then((text) => {
                const result = parseWebForDialog(text);
                if (!result.ok) {
                    toast(`导入失败：${result.issues?.[0]?.path || '$'} ${result.issues?.[0]?.msg || ''}`, 'err');
                    return;
                }
                applyWebImport(result.value);
            }).catch((e) => toast(`读取失败：${e instanceof Error ? e.message : String(e)}`, 'err'));
        },
    }));

    $('webResetBtn').addEventListener('click', () => {
        state = defaultState();
        save();
        renderAll();
        toast('已恢复 DeepSeek + SearXNG 示例', 'ok');
    });

    $('webClearBtn').addEventListener('click', () => {
        state.providers = [];
        save();
        renderAll();
    });

    registerView('model', $('modelLayout'));
    registerView('web', $('webLayout'), renderAll);

    // 页签切换统一由 tabs.js 负责（四个内容分区在 domain-app.js 里注册）
    initTabs();
}

init();
