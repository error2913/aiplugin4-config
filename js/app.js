// 主应用逻辑：表单状态 ↔ DOM ↔ TOML 输出。
import {
    PROVIDER_TEMPLATES, MODEL_TAGS, TAG_VALUES,
    TARGET_PLUGIN_VERSION, PLUGIN_REPO_URL, getTemplate, templateIdForProvider,
} from './templates.js';
import { renderExport, validateConn } from './toml-gen.js';
import { parseConnection, parseExportText, TomlParseError } from './toml-parse.js';

const STORAGE_KEY = 'aiplugin4-config-draft-v1';

// ---------------------------------------------------------------- 状态

/** 自增 id，仅用于 DOM key */
let uid = 0;
const nextId = () => `c${++uid}`;

/** 新建一条空连接 */
function newConn(presetId = 'deepseek') {
    const tpl = getTemplate(presetId);
    return {
        id: nextId(),
        enabled: true,
        templateId: tpl.id,
        provider: tpl.provider,
        baseUrl: tpl.baseUrl,
        apiKey: '',
        models: [],
        types: {},      // 模型名 -> tag
        ignore: false,
    };
}

let conns = [];
let saveTimer = null;

// ---------------------------------------------------------------- 持久化
// 注意：api_key 是敏感信息。默认**不**落盘，只有用户显式勾选「记住」才写入 localStorage。
const REMEMBER_KEY = 'aiplugin4-config-remember-key';

function rememberKeyEnabled() {
    return localStorage.getItem(REMEMBER_KEY) === '1';
}

function saveDraft() {
    try {
        const keepKey = rememberKeyEnabled();
        const data = conns.map(c => ({
            ...c,
            apiKey: keepKey ? c.apiKey : '',
        }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch { /* 隐私模式等：静默忽略 */ }
}

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 300);
}

function loadDraft() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!Array.isArray(data) || data.length === 0) return null;
        return data.map(c => ({
            id: nextId(),
            enabled: c.enabled !== false,
            templateId: c.templateId || templateIdForProvider(c.provider),
            provider: c.provider || '',
            baseUrl: c.baseUrl || '',
            apiKey: c.apiKey || '',
            models: Array.isArray(c.models) ? c.models : [],
            types: c.types && typeof c.types === 'object' ? c.types : {},
            ignore: !!c.ignore,
        }));
    } catch { return null; }
}

// ---------------------------------------------------------------- 渲染：连接卡片

const connListEl = document.getElementById('connList');
const emptyStateEl = document.getElementById('emptyState');

function render() {
    connListEl.innerHTML = '';
    emptyStateEl.hidden = conns.length > 0;

    conns.forEach((conn, i) => {
        connListEl.appendChild(renderCard(conn, i));
    });

    renderOutput();
}

function renderCard(conn, index) {
    const tpl = getTemplate(conn.templateId);
    const errs = validateConn(conn);

    const card = el('div', 'conn-card' + (errs.length ? ' is-invalid' : ''));

    // ---- 头部
    const head = el('div', 'conn-head');
    const idx = el('span', 'conn-index');
    idx.textContent = `连接序号 ${index}`;
    head.appendChild(idx);

    const title = el('div', 'conn-title');
    title.textContent = tpl.label;
    if (conn.provider) {
        const sub = el('span', 'sub');
        sub.textContent = `  ${conn.provider}`;
        title.appendChild(sub);
    }
    head.appendChild(title);

    const del = el('button', 'btn btn-sm btn-danger-ghost');
    del.type = 'button';
    del.textContent = '删除';
    del.onclick = () => {
        conns = conns.filter(c => c.id !== conn.id);
        scheduleSave();
        render();
    };
    head.appendChild(del);
    card.appendChild(head);

    // ---- 主体
    const body = el('div', 'conn-body');

    // 供应商网格
    const pf = el('div', 'field');
    pf.appendChild(labelEl('服务商'));
    const grid = el('div', 'provider-grid');
    for (const t of PROVIDER_TEMPLATES) {
        const chip = el('button', 'provider-chip' + (t.id === conn.templateId ? ' is-active' : ''));
        chip.type = 'button';
        chip.textContent = t.label;
        chip.onclick = () => {
            // 只有用户没改过 base_url（仍等于「当前模板」的默认值或为空）时才跟着换，
            // 避免覆盖用户手工输入的地址。
            const beforeTpl = getTemplate(conn.templateId);
            if (!conn.baseUrl || conn.baseUrl === beforeTpl.baseUrl) conn.baseUrl = t.baseUrl;
            conn.templateId = t.id;
            conn.provider = t.provider;
            scheduleSave();
            render();
        };
        grid.appendChild(chip);
    }
    pf.appendChild(grid);
    if (tpl.notes) {
        const n = el('div', 'field-note' + (/必须填|留空/.test(tpl.notes) ? ' warn' : ''));
        n.textContent = tpl.notes;
        pf.appendChild(n);
    }
    body.appendChild(pf);

    // provider + base_url
    const row = el('div', 'field-row');

    const provF = el('div', 'field');
    provF.appendChild(labelEl('provider', '写入配置的服务商标识，可手工改'));
    const provIn = document.createElement('input');
    provIn.type = 'text';
    provIn.value = conn.provider;
    provIn.placeholder = 'custom-gateway';
    provIn.oninput = () => { conn.provider = provIn.value; scheduleSave(); renderOutput(); };
    provF.appendChild(provIn);
    if (!conn.provider) {
        const w = el('div', 'field-note warn');
        w.textContent = '留空 = 按 OpenAI 兼容处理，此时 base_url 必填';
        provF.appendChild(w);
    }
    row.appendChild(provF);

    const urlF = el('div', 'field');
    urlF.appendChild(labelEl('base_url'));
    const urlIn = document.createElement('input');
    urlIn.type = 'text';
    urlIn.value = conn.baseUrl;
    urlIn.placeholder = 'https://api.example.com/v1';
    urlIn.oninput = () => { conn.baseUrl = urlIn.value; scheduleSave(); renderOutput(); };
    urlF.appendChild(urlIn);
    row.appendChild(urlF);

    body.appendChild(row);

    // api_key
    const keyF = el('div', 'field');
    keyF.appendChild(labelEl('api_key', '必填'));
    const keyRow = el('div', 'key-row');
    const keyIn = document.createElement('input');
    keyIn.type = 'password';
    keyIn.value = conn.apiKey;
    keyIn.placeholder = 'sk-xxxxxxxx';
    keyIn.autocomplete = 'off';
    keyIn.spellcheck = false;
    keyIn.oninput = () => { conn.apiKey = keyIn.value; scheduleSave(); renderOutput(); };
    keyRow.appendChild(keyIn);

    const eye = el('button', 'btn btn-sm');
    eye.type = 'button';
    eye.textContent = '显示';
    eye.onclick = () => {
        const show = keyIn.type === 'password';
        keyIn.type = show ? 'text' : 'password';
        eye.textContent = show ? '隐藏' : '显示';
    };
    keyRow.appendChild(eye);
    keyF.appendChild(keyRow);
    body.appendChild(keyF);

    // 模型清单
    const mF = el('div', 'field');
    mF.appendChild(labelEl('models', '可选：填写后跳过自动拉取，直接用该清单'));
    const mRow = el('div', 'models-input');
    const mIn = document.createElement('input');
    mIn.type = 'text';
    mIn.placeholder = '输入模型名后回车添加';
    const addModel = () => {
        const v = mIn.value.trim();
        if (!v) return;
        if (!conn.models.includes(v)) conn.models.push(v);
        mIn.value = '';
        scheduleSave();
        render();
    };
    mIn.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addModel(); }
        // 退格删掉最后一个
        if (e.key === 'Backspace' && mIn.value === '' && conn.models.length) {
            conn.models.pop();
            scheduleSave();
            render();
        }
    };
    mRow.appendChild(mIn);
    const addBtn = el('button', 'btn btn-sm');
    addBtn.type = 'button';
    addBtn.textContent = '添加';
    addBtn.onclick = addModel;
    mRow.appendChild(addBtn);
    mF.appendChild(mRow);

    if (conn.models.length) {
        const tags = el('div', 'tags');
        for (const m of conn.models) {
            const pill = el('span', 'tag-pill');
            const name = el('span');
            name.textContent = m;
            pill.appendChild(name);

            const sel = document.createElement('select');
            sel.title = '手动声明模型类型（对应 [types]），优先级最高';
            const auto = document.createElement('option');
            auto.value = '';
            auto.textContent = '自动';
            sel.appendChild(auto);
            for (const t of MODEL_TAGS) {
                const o = document.createElement('option');
                o.value = t.value;
                o.textContent = t.label;
                o.title = t.desc;
                sel.appendChild(o);
            }
            sel.value = conn.types[m] || '';
            sel.onchange = () => {
                if (sel.value) conn.types[m] = sel.value;
                else delete conn.types[m];
                scheduleSave();
                renderOutput();
            };
            pill.appendChild(sel);

            const rm = el('button');
            rm.type = 'button';
            rm.textContent = '×';
            rm.title = '移除';
            rm.onclick = () => {
                conn.models = conn.models.filter(x => x !== m);
                delete conn.types[m];
                scheduleSave();
                render();
            };
            pill.appendChild(rm);
            tags.appendChild(pill);
        }
        mF.appendChild(tags);
    }

    // 模型名建议
    if (tpl.modelHints.length) {
        const sug = el('div', 'model-suggest');
        const lbl = el('span', 'lbl');
        lbl.textContent = '示例：';
        sug.appendChild(lbl);
        for (const h of tpl.modelHints) {
            if (conn.models.includes(h)) continue;
            const b = el('button');
            b.type = 'button';
            b.textContent = h;
            b.title = '点击添加（示例，请按你的实际可用模型改）';
            b.onclick = () => {
                conn.models.push(h);
                scheduleSave();
                render();
            };
            sug.appendChild(b);
        }
        if (sug.children.length > 1) mF.appendChild(sug);
    }

    body.appendChild(mF);

    // ignore
    const igF = el('div', 'field');
    const igLabel = el('label', 'toggle');
    const igIn = document.createElement('input');
    igIn.type = 'checkbox';
    igIn.checked = conn.ignore;
    igIn.onchange = () => { conn.ignore = igIn.checked; scheduleSave(); renderOutput(); };
    igLabel.appendChild(igIn);
    const igTxt = el('span');
    igTxt.textContent = '忽略此连接（ignore = 1，占位不生效）';
    igLabel.appendChild(igTxt);
    igF.appendChild(igLabel);
    body.appendChild(igF);

    card.appendChild(body);
    return card;
}

function labelEl(text, note) {
    const l = document.createElement('label');
    l.textContent = text;
    if (note) {
        const s = el('span', 'field-note');
        s.textContent = `　${note}`;
        l.appendChild(s);
    }
    return l;
}

function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
}

// ---------------------------------------------------------------- 渲染：输出

const previewEl = document.getElementById('preview');
const validationEl = document.getElementById('validationBox');
const maskKeyEl = document.getElementById('maskKey');

function renderOutput() {
    const maskKey = maskKeyEl.checked;
    const text = renderExport(conns, { maskKey });
    previewEl.innerHTML = highlight(text);

    // 校验汇总
    const problems = [];
    conns.forEach((c, i) => {
        const errs = validateConn(c);
        if (errs.length) problems.push({ i, tpl: getTemplate(c.templateId).label, errs });
    });

    if (problems.length === 0) {
        validationEl.hidden = true;
        validationEl.innerHTML = '';
    } else {
        validationEl.hidden = false;
        const title = el('div', 'vtitle');
        title.textContent = '配置有问题，请修正后再复制：';
        validationEl.innerHTML = '';
        validationEl.appendChild(title);
        const ul = document.createElement('ul');
        for (const p of problems) {
            const li = document.createElement('li');
            const b = document.createElement('b');
            b.textContent = `${p.tpl}（连接序号 ${p.i}）：`;
            li.appendChild(b);
            li.appendChild(document.createTextNode(p.errs.join('；')));
            ul.appendChild(li);
        }
        validationEl.appendChild(ul);
    }
}

/** 轻量 TOML 语法着色 */
function highlight(text) {
    if (!text) return '';
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc(text)
        .split('\n')
        .map((line) => {
            const t = line.trim();
            if (t.startsWith('=')) return `<span class="tk-comment">${line}</span>`;
            if (/^aiplugin4「api连接」/.test(t)) return `<span class="tk-comment">${line}</span>`;
            if (t.startsWith('#')) return `<span class="tk-comment">${line}</span>`;
            if (/^\[.+\]$/.test(t)) return `<span class="tk-tbl">${line}</span>`;
            const m = /^(\s*)("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)(\s*=\s*)(.*)$/.exec(line);
            if (m) {
                const [, , k, sep, rest] = m;
                const val = rest
                    .replace(/("(?:[^"\\]|\\.)*")/g, '<span class="tk-str">$1</span>')
                    .replace(/\b(\d+)\b(?![^<]*<\/span>)/g, '<span class="tk-num">$1</span>');
                return `<span class="tk-key">${k}</span><span class="tk-sep">${sep}</span>${val}`;
            }
            return line;
        })
        .join('\n');
}

// ---------------------------------------------------------------- 交互

document.getElementById('addConnBtn').onclick = () => {
    conns.push(newConn('deepseek'));
    scheduleSave();
    render();
};

document.getElementById('clearBtn').onclick = () => {
    if (conns.length && !confirm('确定清空全部连接？')) return;
    conns = [];
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    render();
};

maskKeyEl.onchange = renderOutput;

document.getElementById('copyBtn').onclick = async () => {
    const text = renderExport(conns, { maskKey: maskKeyEl.checked });
    if (!text) return toast('没有可复制的内容', 'err');
    try {
        await navigator.clipboard.writeText(text);
        toast('已复制到剪贴板', 'ok');
    } catch {
        // 非 HTTPS / 权限被拒时的兜底
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            toast('已复制到剪贴板', 'ok');
        } catch {
            toast('复制失败，请手动全选预览区内容', 'err');
        }
        document.body.removeChild(ta);
    }
};

document.getElementById('downloadBtn').onclick = () => {
    const text = renderExport(conns, { maskKey: maskKeyEl.checked });
    if (!text) return toast('没有可下载的内容', 'err');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aiplugin4-api-connections.toml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---- 导入
const importMsgEl = document.getElementById('importMsg');

document.getElementById('importBtn').onclick = () => {
    const raw = document.getElementById('importText').value;
    if (!raw.trim()) return showImportMsg('请先粘贴配置内容', false);
    try {
        const parsed = parseExportText(raw);
        if (parsed.length === 0) return showImportMsg('没有解析到任何连接', false);

        const imported = parsed.map((p) => {
            const provider = p.fields.provider || '';
            const models = p.fields.models || [];
            const types = {};
            for (const k of Object.keys(p.types || {})) types[k] = p.types[k];
            return {
                id: nextId(),
                enabled: true,
                templateId: templateIdForProvider(provider),
                provider,
                baseUrl: p.fields.baseUrl || '',
                apiKey: p.fields.apiKey || '',
                // [types] 中声明的模型若不在 models 里，补进去（否则生成时会被丢弃）
                models: Array.from(new Set([...models, ...Object.keys(types)])),
                types,
                ignore: !!p.fields.ignore,
            };
        });

        conns = imported;
        scheduleSave();
        document.getElementById('importText').value = '';
        render();

        const warned = parsed.filter(p => p.unknown && p.unknown.length);
        let msg = `已导入 ${imported.length} 个连接。`;
        if (warned.length) {
            const keys = Array.from(new Set(warned.flatMap(p => p.unknown)));
            msg += ` 注意：忽略了无法识别的键 ${keys.join('、')}。`;
        }
        showImportMsg(msg, true);
    } catch (e) {
        const detail = e instanceof TomlParseError ? e.message : (e.message || String(e));
        showImportMsg(`解析失败 —— ${detail}`, false);
    }
};

function showImportMsg(text, ok) {
    importMsgEl.hidden = false;
    importMsgEl.className = 'import-msg ' + (ok ? 'ok' : 'err');
    importMsgEl.textContent = text;
}

// ---- 记住 key
(function initRememberKey() {
    const keyF = el('div', 'field');
    const l = el('label', 'toggle');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = rememberKeyEnabled();
    cb.onchange = () => {
        try { localStorage.setItem(REMEMBER_KEY, cb.checked ? '1' : '0'); } catch { /* ignore */ }
        if (!cb.checked) {
            // 关闭时立刻把已存的 key 抹掉
            saveDraft();
        } else {
            saveDraft();
        }
        toast(cb.checked ? '已开启：API Key 会明文存入本机浏览器' : '已关闭：API Key 不再落盘', 'ok');
    };
    l.appendChild(cb);
    const s = el('span');
    s.textContent = '在本机记住 API Key（明文存入 localStorage，公用电脑请勿开启）';
    l.appendChild(s);
    keyF.appendChild(l);

    const target = document.querySelector('.pane-form');
    const anchor = document.getElementById('emptyState');
    target.insertBefore(keyF, anchor);
})();

// ---------------------------------------------------------------- toast

const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg, kind = '') {
    toastEl.textContent = msg;
    toastEl.className = 'toast ' + kind;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2200);
}

// ---------------------------------------------------------------- 启动

document.getElementById('versionBadge').innerHTML =
    `适配 aiplugin4 v${TARGET_PLUGIN_VERSION} · <a href="${PLUGIN_REPO_URL}" target="_blank" rel="noopener">源码</a>`;

conns = loadDraft() || [newConn('deepseek')];
render();
