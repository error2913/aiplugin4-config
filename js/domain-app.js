// 角色 / 技能 / MCP / 知识库四个分区的通用交互层。
//
// 四个分区的结构一致（一组条目 + 一份 JSON 输出 + 导入 / 文件导入 / 复制），
// 差异全部收敛在 js/domains/*.js 的 spec 里；本文件只做 DOM 与通用行为，避免复制四份。
import { DOMAIN_SPECS } from './domains/index.js';
import {
    clone, formatPlatform, parsePlatform, stringifyConfig, withUids,
} from './domains/common.js';
import { initTabs, registerView } from './tabs.js';
import {
    apiKeyInput, cardActions, copyText, downloadText, openImportDialog, pickFiles, readFileText, toast,
} from './ui.js';

// ---------------------------------------------------------------- 小工具

const $ = (id) => document.getElementById(id);
const el = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
};

let uidSeq = 0;
const nextUid = () => `d${++uidSeq}-${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------- 状态与草稿

/** @type {Map<string, {items:any[], pretty:boolean, mask:boolean}>} */
const states = new Map();
const saveTimers = new Map();

function loadState(spec) {
    const fallback = withUids(spec.defaults, nextUid).map(item => spec.normalizeItem(item));
    try {
        const raw = localStorage.getItem(spec.storageKey);
        if (!raw) return { items: fallback, pretty: false, mask: false };
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed?.items) ? parsed.items : [];
        return {
            items: items.map(item => {
                const normalized = spec.normalizeItem(item);
                normalized._uid = item && typeof item._uid === 'string' ? item._uid : nextUid();
                return normalized;
            }),
            pretty: false,
            mask: false,
        };
    } catch {
        return { items: fallback, pretty: false, mask: false };
    }
}

function saveStateSoon(spec, state) {
    clearTimeout(saveTimers.get(spec.id));
    saveTimers.set(spec.id, setTimeout(() => {
        try {
            localStorage.setItem(spec.storageKey, JSON.stringify({ items: state.items }));
        } catch { /* 隐私模式 / 配额满：静默忽略 */ }
    }, 350));
}

function defaultItems(spec) {
    return withUids(spec.defaults, nextUid).map(item => spec.normalizeItem(item));
}

// ---------------------------------------------------------------- 布局

function buildLayout(spec) {
    const layout = $(`${spec.id}Layout`);
    if (!layout) return null;
    const maskToggle = spec.supportMask
        ? `<label class="toggle" title="把 token / Authorization 等敏感字段换成占位符，便于截图分享">
             <input type="checkbox" id="${spec.id}Mask"><span>遮蔽敏感信息</span>
           </label>`
        : '';
    layout.innerHTML = `
      <section class="pane">
        <div class="pane-head">
          <h2>${spec.title}</h2>
          <span class="pane-hint">${spec.hint}</span>
        </div>
        <div class="drop-zone" id="${spec.id}Drop">
          <strong>拖入文件</strong><span>${spec.fileHint}</span>
        </div>
        <div class="card-grid" id="${spec.id}Cards"></div>
      </section>
      <section class="pane pane-output">
        <div class="pane-head">
          <h2>生成的配置</h2>
          <div class="toggle-group">
            ${maskToggle}
            <label class="toggle" title="打开后输出多行缩进 JSON（默认紧凑单行）">
              <input type="checkbox" id="${spec.id}Pretty"><span>格式化</span>
            </label>
          </div>
        </div>
        <div id="${spec.id}Validation" class="validation" hidden></div>
        <pre id="${spec.id}Preview" class="preview"></pre>
        <div class="actions">
          <button class="btn btn-primary" id="${spec.id}Copy" type="button">复制全部</button>
          <button class="btn" id="${spec.id}Download" type="button">下载 .json</button>
          <button class="btn" id="${spec.id}ImportOpen" type="button">导入…</button>
          <button class="btn" id="${spec.id}FileOpen" type="button">导入文件…</button>
          <button class="btn" id="${spec.id}Reset" type="button">恢复默认</button>
          <button class="btn" id="${spec.id}Clear" type="button">清空</button>
        </div>
        <div id="${spec.id}FileMsg" class="file-msg" hidden></div>
        <details class="usage-box">
          <summary>怎么用？</summary>
          <ol class="usage">${spec.usage.map(line => `<li>${line}</li>`).join('')}</ol>
          <p class="hint">
            本工具只生成文本，不会自动写入海豹。配置格式为 JSON v1；
            修改插件里的配置后按页面提示 refresh / 重载 JS 生效。
          </p>
        </details>
      </section>`;
    return layout;
}

// ---------------------------------------------------------------- 卡片

function renderCards(spec, state) {
    const wrap = $(`${spec.id}Cards`);
    if (!wrap) return;
    wrap.innerHTML = '';
    state.items.forEach((item, index) => {
        const card = el('div', 'dcard' + (item.enabled === false ? ' is-off' : ''));
        const head = el('div', 'dcard-head');
        const title = el('div', 'dcard-title');
        title.textContent = item.name || '（未命名）';
        title.title = item.name || '（未命名）';
        const id = el('span', 'dcard-id');
        id.textContent = String(index + 1);
        // 启用开关：只控制是否写进生成配置，不产生 enabled 字段
        const toggle = el('label', 'toggle');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = item.enabled !== false;
        cb.title = '启用（关闭 = 从生成的配置里移除）';
        cb.addEventListener('change', () => {
            item.enabled = cb.checked;
            saveStateSoon(spec, state);
            renderAll(spec, state);
        });
        toggle.append(cb, document.createTextNode('启用'));
        head.append(title, id, toggle);
        const meta = el('div', 'dcard-meta');
        const metaText = spec.cardMeta(item) + (item.enabled === false ? ' · 已停用（不写入配置）' : '');
        meta.textContent = metaText;
        meta.title = metaText;
        const actions = cardActions({
            canUp: index > 0,
            canDown: index < state.items.length - 1,
            onUp: () => moveItem(spec, state, index, -1),
            onDown: () => moveItem(spec, state, index, 1),
            onEdit: () => openEditor(spec, state, index),
            onDelete: () => {
                if (!confirm(`删除${spec.itemLabel}「${item.name || '未命名'}」？`)) return;
                state.items.splice(index, 1);
                saveStateSoon(spec, state);
                renderAll(spec, state);
            },
        });
        card.append(head, meta, actions);
        wrap.appendChild(card);
    });
    const add = el('div', 'dcard dcard-add');
    add.textContent = `+ 添加${spec.itemLabel}`;
    add.onclick = () => openEditor(spec, state, null);
    wrap.appendChild(add);
}

function moveItem(spec, state, index, delta) {
    const target = index + delta;
    if (target < 0 || target >= state.items.length) return;
    const [item] = state.items.splice(index, 1);
    state.items.splice(target, 0, item);
    saveStateSoon(spec, state);
    renderAll(spec, state);
}

// ---------------------------------------------------------------- 编辑面板

let panelDomain = null;
let panelState = null;
let panelIndex = null;
let panelDraft = null;

function ensurePanel() {
    if ($('domainPanel')) return;
    const backdrop = el('div', 'backdrop');
    backdrop.id = 'domainBackdrop';
    backdrop.hidden = true;
    backdrop.onclick = closeEditor;
    const panel = el('aside', 'panel');
    panel.id = 'domainPanel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.innerHTML = `
      <div class="panel-head">
        <h2 id="domainPanelTitle">编辑</h2>
        <button class="panel-x" id="domainPanelClose" type="button" title="关闭">×</button>
      </div>
      <div class="panel-body" id="domainPanelBody"></div>
      <div class="panel-foot">
        <button class="btn" id="domainPanelCancel" type="button">取消</button>
        <button class="btn btn-primary" id="domainPanelSave" type="button">保存</button>
      </div>`;
    document.body.append(backdrop, panel);
    $('domainPanelClose').onclick = closeEditor;
    $('domainPanelCancel').onclick = closeEditor;
    $('domainPanelSave').onclick = saveEditor;
}

function openEditor(spec, state, index) {
    ensurePanel();
    panelDomain = spec;
    panelState = state;
    panelIndex = index;
    panelDraft = index === null ? spec.newItem() : clone(state.items[index]);
    $('domainPanelTitle').textContent = `${index === null ? '添加' : '编辑'}${spec.itemLabel}`;
    renderEditorFields();
    $('domainBackdrop').hidden = false;
    $('domainPanel').hidden = false;
}

function closeEditor() {
    if (!$('domainPanel')) return;
    $('domainPanel').hidden = true;
    $('domainBackdrop').hidden = true;
    $('domainPanelBody').innerHTML = '';
    panelDomain = null;
    panelState = null;
    panelIndex = null;
    panelDraft = null;
}

function renderEditorFields() {
    const spec = panelDomain;
    const body = $('domainPanelBody');
    body.innerHTML = '';
    for (const field of spec.fields) {
        const wrap = el('div', 'field');
        const label = el('label', 'field-label');
        label.textContent = field.label + (field.required ? '（必填）' : '');
        wrap.appendChild(label);
        let control;
        const value = panelDraft[field.key];
        if (field.type === 'textarea') {
            control = el('textarea', 'json-area');
            control.rows = field.rows || 10;
            control.value = value ?? '';
            control.oninput = () => { panelDraft[field.key] = control.value; };
        } else if (field.type === 'json') {
            control = el('textarea', 'json-area');
            control.rows = field.rows || 6;
            control.spellcheck = false;
            control.value = value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : '{}';
            control.oninput = () => { panelDraft.__jsonDirty = true; };
        } else if (field.type === 'secret') {
            control = apiKeyInput(value ?? '', (v) => { panelDraft[field.key] = v; }, { placeholder: field.placeholder });
        } else if (field.type === 'platform') {
            control = el('input');
            control.type = 'text';
            control.value = formatPlatform(value);
            control.oninput = () => { panelDraft[field.key] = parsePlatform(control.value); };
        } else if (field.type === 'checkbox') {
            control = el('input');
            control.type = 'checkbox';
            control.checked = value !== false;
            control.onchange = () => { panelDraft[field.key] = control.checked; };
        } else if (field.type === 'select') {
            control = el('select');
            for (const [val, text] of field.options || []) {
                const opt = document.createElement('option');
                opt.value = val;
                opt.textContent = text;
                selectAppend(control, opt, val === value);
            }
            control.onchange = () => { panelDraft[field.key] = control.value; };
        } else {
            control = el('input');
            control.type = 'text';
            control.value = value ?? '';
            if (field.maxLength) control.maxLength = field.maxLength;
            control.oninput = () => { panelDraft[field.key] = control.value; };
        }
        if (field.placeholder) control.placeholder = field.placeholder;
        control.dataset.fieldKey = field.key;
        control.dataset.fieldType = field.type;
        const id = `domainField_${spec.id}_${field.key}`;
        const idTarget = control.matches?.('input,textarea,select')
            ? control
            : (control.querySelector('input,textarea,select') || control);
        idTarget.id = id;
        label.htmlFor = id;
        wrap.appendChild(control);
        if (field.note) {
            const note = el('div', 'field-note');
            note.textContent = field.note;
            wrap.appendChild(note);
        }
        body.appendChild(wrap);
    }
    const err = el('div', 'json-err');
    err.id = 'domainPanelErr';
    err.hidden = true;
    body.appendChild(err);
}

function selectAppend(select, option, selected) {
    option.selected = selected;
    select.appendChild(option);
}

function saveEditor() {
    const spec = panelDomain;
    const state = panelState;
    const index = panelIndex;
    const draft = panelDraft;
    if (!spec || !state || !draft) return;
    const err = $('domainPanelErr');
    // JSON 字段：保存时解析，错了就停在面板里
    for (const field of spec.fields) {
        if (field.type !== 'json') continue;
        const control = $(`domainField_${spec.id}_${field.key}`);
        const raw = String(control?.value ?? '').trim();
        if (!raw) {
            draft[field.key] = {};
            continue;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('必须是 JSON 对象');
            }
            draft[field.key] = parsed;
        } catch (e) {
            if (err) {
                err.hidden = false;
                err.textContent = `${field.label} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`;
            }
            return;
        }
    }
    if (err) err.hidden = true;
    const normalized = spec.normalizeItem(draft);
    if (index === null) {
        normalized._uid = nextUid();
        state.items.push(normalized);
    } else {
        normalized._uid = state.items[index]._uid;
        state.items[index] = normalized;
    }
    saveStateSoon(spec, state);
    closeEditor();
    renderAll(spec, state);
}

// ---------------------------------------------------------------- 输出 / 校验

function currentConfig(spec, state) {
    let config = spec.build(state.items);
    if (spec.supportMask && state.mask && typeof spec.maskConfig === 'function') {
        config = spec.maskConfig(config);
    }
    return config;
}

function renderOutput(spec, state) {
    const preview = $(`${spec.id}Preview`);
    if (!preview) return;
    const { problems, warnings } = spec.validate(state.items);
    const config = currentConfig(spec, state);
    preview.textContent = stringifyConfig(config, state.pretty);

    const box = $(`${spec.id}Validation`);
    box.innerHTML = '';
    if (problems.length === 0 && warnings.length === 0) {
        box.hidden = true;
    } else {
        box.hidden = false;
        if (problems.length > 0) {
            const title = el('div', 'vtitle');
            title.textContent = `配置有 ${problems.length} 处问题，修正后才能复制：`;
            box.appendChild(title);
            box.appendChild(issueList(problems));
        }
        if (warnings.length > 0) {
            const title = el('div', 'vtitle warn');
            title.textContent = `提示（不影响复制）：${warnings.length} 条`;
            box.appendChild(title);
            box.appendChild(issueList(warnings));
        }
    }
    const copy = $(`${spec.id}Copy`);
    if (copy) copy.disabled = problems.length > 0;
}

function issueList(issues) {
    const ul = el('ul');
    for (const item of issues) {
        const li = el('li');
        const code = el('code');
        code.textContent = item.path;
        li.appendChild(code);
        li.appendChild(document.createTextNode(' ' + item.msg));
        ul.appendChild(li);
    }
    return ul;
}

function renderAll(spec, state) {
    renderCards(spec, state);
    renderOutput(spec, state);
}

// ---------------------------------------------------------------- 导入 / 文件导入

function applyDomainImport(spec, state, result) {
    state.items = withUids(result.items, nextUid).map(item => spec.normalizeItem(item));
    saveStateSoon(spec, state);
    renderAll(spec, state);
    toast(`已导入 ${state.items.length} 个${spec.itemLabel}`, 'ok');
}

function openDomainImport(spec, state) {
    openImportDialog({
        title: `导入${spec.itemLabel}配置`,
        hint: `粘贴一份已有的「${spec.configKey}」JSON（或本页签之前下载的文件内容）。导入会替换当前内容；校验不通过时不会改动任何东西。`,
        placeholder: spec.importPlaceholder || `{"version":1,"${spec.collectionKey}":[…]}`,
        rows: 12,
        parse: (text) => spec.parseImport(text),
        onSuccess: (res) => applyDomainImport(spec, state, res),
    });
}

function showFileMessage(spec, lines) {
    const box = $(`${spec.id}FileMsg`);
    if (!box) return;
    box.innerHTML = '';
    if (!lines || lines.length === 0) {
        box.hidden = true;
        return;
    }
    const title = el('div', 'vtitle');
    title.textContent = '文件导入结果：';
    box.appendChild(title);
    const ul = el('ul');
    for (const line of lines) {
        const li = el('li');
        li.textContent = line;
        ul.appendChild(li);
    }
    box.appendChild(ul);
    box.hidden = false;
}

async function importFiles(spec, state, fileList) {
    const files = [...fileList];
    if (files.length === 0) return;
    const added = [];
    const messages = [];
    for (const file of files) {
        if (file.size > 2 * 1024 * 1024) {
            messages.push(`${file.name}：文件超过 2MB，已跳过`);
            continue;
        }
        let text;
        try {
            text = await readFileText(file);
        } catch (e) {
            messages.push(`${file.name}：读取失败（${e instanceof Error ? e.message : String(e)}）`);
            continue;
        }
        const result = spec.fromFile(file.name, text);
        for (const issue of result.warnings || []) messages.push(`${file.name}：${issue.msg}`);
        if (!result.ok) {
            for (const issue of result.issues || []) messages.push(`${file.name}：${issue.msg}`);
            continue;
        }
        const items = result.items || (result.item ? [result.item] : []);
        if (items.length === 0) {
            messages.push(`${file.name}：没有解析出${spec.itemLabel}`);
            continue;
        }
        for (const item of items) {
            const normalized = spec.normalizeItem(item);
            normalized._uid = nextUid();
            added.push(normalized);
        }
    }
    if (added.length > 0) {
        state.items.push(...added);
        saveStateSoon(spec, state);
        renderAll(spec, state);
        messages.unshift(`已从 ${files.length} 个文件导入 ${added.length} 个${spec.itemLabel}`);
    }
    showFileMessage(spec, messages);
    toast(added.length > 0 ? `已导入 ${added.length} 个${spec.itemLabel}` : '没有导入任何内容', added.length > 0 ? 'ok' : 'err');
}

function wireFileDrop(spec, state) {
    const zone = $(`${spec.id}Drop`);
    if (!zone) return;
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    zone.addEventListener('dragover', (e) => {
        stop(e);
        e.dataTransfer.dropEffect = 'copy';
        zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
        stop(e);
        zone.classList.remove('drag-over');
        importFiles(spec, state, e.dataTransfer.files);
    });
}

// ---------------------------------------------------------------- 绑定 & 启动

function wireSpec(spec, state) {
    $(`${spec.id}Pretty`).addEventListener('change', (e) => {
        state.pretty = e.target.checked;
        renderOutput(spec, state);
    });
    const mask = $(`${spec.id}Mask`);
    if (mask) {
        mask.addEventListener('change', (e) => {
            state.mask = e.target.checked;
            renderOutput(spec, state);
        });
    }

    $(`${spec.id}Copy`).addEventListener('click', async () => {
        const ok = await copyText($(`${spec.id}Preview`).textContent);
        const where = `海豹 → aiplugin4 →「${spec.configGroup}」→「${spec.configKey}」`;
        toast(ok ? `已复制，去 ${where} 粘贴` : '复制失败，请手动全选复制', ok ? 'ok' : 'err');
    });

    $(`${spec.id}Download`).addEventListener('click', () => {
        downloadText(`${spec.fileBase}.json`, $(`${spec.id}Preview`).textContent);
    });

    $(`${spec.id}ImportOpen`).addEventListener('click', () => openDomainImport(spec, state));
    $(`${spec.id}FileOpen`).addEventListener('click', () => pickFiles({
        accept: spec.accept,
        multiple: true,
        onFiles: (files) => importFiles(spec, state, files),
    }));

    $(`${spec.id}Reset`).addEventListener('click', () => {
        state.items = defaultItems(spec);
        saveStateSoon(spec, state);
        renderAll(spec, state);
        toast('已恢复出厂默认', 'ok');
    });

    $(`${spec.id}Clear`).addEventListener('click', () => {
        if (!confirm(`清空全部${spec.itemLabel}？`)) return;
        state.items = [];
        saveStateSoon(spec, state);
        renderAll(spec, state);
    });

    wireFileDrop(spec, state);
}

function init() {
    for (const spec of DOMAIN_SPECS) {
        const layout = buildLayout(spec);
        if (!layout) continue;
        const state = loadState(spec);
        states.set(spec.id, state);
        wireSpec(spec, state);
        renderAll(spec, state);
        registerView(spec.id, layout, () => renderAll(spec, state));
    }
    // web-app.js 已经调用过 initTabs（幂等），这里不再重复；直接按地址栏显示
    initTabs();
}

init();

