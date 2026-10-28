// 角色 / 技能 / MCP / 知识库 / 事件触发五个分区的通用交互层。
//
// 五个分区的结构一致（一组条目 + 一份 JSON 输出 + 导入 / 文件导入 / 复制），
// 差异全部收敛在 js/domains/*.js 的 spec 里；本文件只做 DOM 与通用行为，避免复制五份。
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

/** 多行文本 → 字符串数组（去空行、去首尾空白） */
function splitLines(text) {
    return String(text ?? '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
}

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
        // 卡片标题：分区可自定义（事件触发用中文短事件名，没有 name 字段）
        const displayTitle = typeof spec.cardTitle === 'function'
            ? spec.cardTitle(item)
            : (item.name || '（未命名）');
        title.textContent = displayTitle;
        title.title = displayTitle;
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
                if (!confirm(`删除${spec.itemLabel}「${displayTitle}」？`)) return;
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
    const body = $('domainPanelBody');
    body.innerHTML = '';
    for (const field of panelDomain.fields) {
        const rendered = renderField(field);
        if (rendered) body.appendChild(rendered);
    }
    const err = el('div', 'json-err');
    err.id = 'domainPanelErr';
    err.hidden = true;
    body.appendChild(err);
}

/** 分区配置里的选项可以是数组，也可以是依赖草稿的回调（动态选项） */
function resolveDynamic(value) {
    return typeof value === 'function' ? value(panelDraft) : value;
}

/** 字段值变更：写回草稿；分区 onFieldChange 返回 true 时重渲染面板（如切换事件后换预设/条件） */
function commitField(field, value) {
    const prev = panelDraft[field.key];
    panelDraft[field.key] = value;
    if (typeof panelDomain.onFieldChange === 'function'
        && panelDomain.onFieldChange(field.key, value, prev, panelDraft)) {
        renderEditorFields();
    }
}

function appendOption(parent, value, text, selected) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    parent.appendChild(option);
    selectAppend(parent, option, selected);
}

/** select 支持 optionGroups（分组）+ options（末尾追加项），两者都可为回调 */
function buildSelect(field, value) {
    const select = el('select');
    const groups = resolveDynamic(field.optionGroups);
    const options = resolveDynamic(field.options);
    if (Array.isArray(groups)) {
        for (const group of groups) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = group.label || '';
            for (const [val, text] of group.options || []) appendOption(optgroup, val, text, val === value);
            select.appendChild(optgroup);
        }
    }
    for (const [val, text] of (Array.isArray(options) ? options : [])) {
        appendOption(select, val, text, val === value);
    }
    return select;
}

// ---------------------------------------------------------------- 条件编辑器

function defaultConditionsParse(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: true, value: [] };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return { ok: false, error: `不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
    }
    if (!Array.isArray(parsed)) return { ok: false, error: '必须是 JSON 数组' };
    return { ok: true, value: parsed };
}

function parseConditions(field, text) {
    return typeof field.parseText === 'function' ? field.parseText(text) : defaultConditionsParse(text);
}

function conditionFieldDef(defs, value) {
    return defs.find(def => def.value === value)
        || { value: '', label: '（请选择字段）', kind: 'text' };
}

function conditionDefaultValue(def) {
    if (!def) return '';
    if (def.kind === 'boolean') return true;
    if (def.kind === 'enum' && Array.isArray(def.options) && def.options.length > 0) return def.options[0];
    return '';
}

function conditionValueText(row, def) {
    if (!row) return '';
    if (Object.prototype.hasOwnProperty.call(row, 'regex')) return String(row.regex ?? '');
    if (row.equals === undefined || row.equals === null) return '';
    return String(row.equals);
}

/**
 * conditions 字段类型：可视化条件行 + 「直接编辑 JSON」折叠，两者双向同步。
 * 行数据直接写回 panelDraft[field.key]（规范数组），保存时再统一校验。
 */
function renderConditionsField(field) {
    const wrap = el('div', 'cond-editor');
    const list = el('div', 'cond-list');
    list.id = `domainField_${panelDomain.id}_${field.key}_list`;
    const error = el('div', 'cond-error');
    error.hidden = true;
    const actions = el('div', 'cond-actions');
    const addButton = el('button', 'btn btn-sm');
    addButton.type = 'button';
    addButton.textContent = field.addLabel || '+ 添加条件';
    addButton.id = `domainField_${panelDomain.id}_${field.key}_add`;
    actions.appendChild(addButton);
    wrap.append(list, actions, error);

    const rows = () => {
        if (!Array.isArray(panelDraft[field.key])) panelDraft[field.key] = [];
        return panelDraft[field.key];
    };
    const defs = () => {
        const value = resolveDynamic(field.conditionFields);
        return Array.isArray(value) ? value : [];
    };

    // 枚举字段的建议值（input + datalist，允许手输）
    const datalistIds = new Map();
    for (const def of defs()) {
        if (def.kind !== 'enum' || !Array.isArray(def.options) || def.options.length === 0) continue;
        const datalist = document.createElement('datalist');
        const id = `domainCondList_${panelDomain.id}_${field.key}_${def.value}`;
        datalist.id = id;
        for (const option of def.options) {
            const item = document.createElement('option');
            item.value = option;
            datalist.appendChild(item);
        }
        wrap.appendChild(datalist);
        datalistIds.set(def.value, id);
    }

    let jsonArea = null;
    const syncJson = () => {
        if (jsonArea) jsonArea.value = JSON.stringify(rows(), null, 2);
    };

    const buildRow = (row, index) => {
        const rowEl = el('div', 'cond-row');
        rowEl.dataset.conditionIndex = String(index);
        const def = conditionFieldDef(defs(), row && row.field);
        const isRegex = !!(row && Object.prototype.hasOwnProperty.call(row, 'regex'));

        const fieldSelect = el('select', 'cond-field');
        fieldSelect.title = '匹配字段';
        for (const item of defs()) appendOption(fieldSelect, item.value, item.label, item.value === def.value);
        fieldSelect.onchange = () => {
            const nextDef = conditionFieldDef(defs(), fieldSelect.value);
            const next = { field: fieldSelect.value };
            if (isRegex) next.regex = '';
            else next.equals = conditionDefaultValue(nextDef);
            rows()[index] = next;
            renderRows();
        };

        const opSelect = el('select', 'cond-op');
        opSelect.title = '比较方式';
        appendOption(opSelect, 'equals', '等于', !isRegex);
        appendOption(opSelect, 'regex', '匹配正则', isRegex);
        opSelect.onchange = () => {
            const raw = isRegex ? row.regex : row.equals;
            const next = { field: row.field };
            if (opSelect.value === 'regex') next.regex = raw === true ? 'true' : String(raw ?? '');
            else next.equals = def.kind === 'boolean' ? raw === true || raw === 'true' : raw;
            rows()[index] = next;
            renderRows();
        };

        const valueWrap = el('div', 'cond-value-wrap');
        let control;
        if (isRegex) {
            control = el('input');
            control.type = 'text';
            control.value = conditionValueText(row, def);
            control.placeholder = '正则，如 ^QQ:100';
            control.oninput = () => { row.regex = control.value; syncJson(); };
        } else if (def.kind === 'boolean') {
            control = el('select');
            appendOption(control, 'true', 'true（是）', row.equals === true || row.equals === 'true');
            appendOption(control, 'false', 'false（否）', row.equals === false || row.equals === 'false');
            control.onchange = () => { row.equals = control.value === 'true'; syncJson(); };
        } else {
            control = el('input');
            control.type = 'text';
            control.value = conditionValueText(row, def);
            const datalistId = datalistIds.get(def.value);
            if (datalistId) control.setAttribute('list', datalistId);
            control.placeholder = def.kind === 'enum' ? '可直接输入或从建议里选' : '';
            control.oninput = () => { row.equals = control.value; syncJson(); };
        }
        control.classList.add('cond-value');
        valueWrap.appendChild(control);

        const del = el('button', 'btn btn-sm btn-danger cond-del');
        del.type = 'button';
        del.textContent = '删除';
        del.title = '删除该条件';
        del.onclick = () => {
            rows().splice(index, 1);
            renderRows();
        };

        rowEl.append(fieldSelect, opSelect, valueWrap, del);
        return rowEl;
    };

    const renderRows = (opts = {}) => {
        list.innerHTML = '';
        const current = rows();
        if (current.length === 0) {
            const empty = el('div', 'cond-empty');
            empty.textContent = field.emptyText || '没有条件';
            list.appendChild(empty);
        }
        current.forEach((row, index) => list.appendChild(buildRow(row, index)));
        if (opts.syncJson !== false) syncJson();
    };

    addButton.onclick = () => {
        const def = defs()[0];
        rows().push({ field: def ? def.value : '', equals: conditionDefaultValue(def) });
        error.hidden = true;
        renderRows();
    };

    if (field.jsonLabel !== false) {
        const details = el('details', 'json-editor');
        const summary = el('summary');
        summary.textContent = field.jsonLabel || '直接编辑 JSON';
        const jsonBody = el('div', 'json-editor-body');
        jsonArea = el('textarea', 'json-area');
        jsonArea.rows = field.rows || 6;
        jsonArea.spellcheck = false;
        jsonArea.id = `domainField_${panelDomain.id}_${field.key}_json`;
        jsonArea.dataset.conditionsJson = field.key;
        jsonArea.value = JSON.stringify(rows(), null, 2);
        jsonArea.oninput = () => {
            const result = parseConditions(field, jsonArea.value);
            if (!result.ok) {
                error.hidden = false;
                error.textContent = result.error || 'JSON 不合法';
                return;
            }
            error.hidden = true;
            panelDraft[field.key] = result.value;
            // 不回写 textarea，避免打断输入；行编辑器实时跟着 JSON 变
            renderRows({ syncJson: false });
        };
        jsonBody.appendChild(jsonArea);
        details.append(summary, jsonBody);
        wrap.appendChild(details);
    }

    renderRows();
    return wrap;
}

// ---------------------------------------------------------------- 字段渲染

function renderField(field) {
    // 折叠分组（如事件触发的「作用范围（高级）」）
    if (field.type === 'details') {
        const details = el('details', 'json-editor');
        const summary = el('summary');
        summary.textContent = field.summary || field.label || '';
        const body = el('div', 'json-editor-body');
        for (const child of field.fields || []) {
            const childEl = renderField(child);
            if (childEl) body.appendChild(childEl);
        }
        details.append(summary, body);
        return details;
    }
    if (typeof field.visibleIf === 'function' && !field.visibleIf(panelDraft)) return null;

    const wrap = el('div', 'field');
    const label = el('label', 'field-label');
    label.textContent = field.label + (field.required ? '（必填）' : '');
    wrap.appendChild(label);
    const value = panelDraft[field.key];
    let control;
    if (field.type === 'textarea') {
        control = el('textarea', 'json-area');
        control.rows = field.rows || 10;
        control.value = value ?? '';
        control.oninput = () => commitField(field, control.value);
    } else if (field.type === 'lines') {
        // 多行文本 ↔ 字符串数组（每行一个值），如事件触发的 sessions / exclude
        control = el('textarea', 'json-area');
        control.rows = field.rows || 6;
        control.value = Array.isArray(value) ? value.join('\n') : String(value ?? '');
        control.oninput = () => commitField(field, splitLines(control.value));
    } else if (field.type === 'json') {
        const isArray = field.jsonKind === 'array';
        control = el('textarea', 'json-area');
        control.rows = field.rows || 6;
        control.spellcheck = false;
        const current = isArray
            ? (Array.isArray(value) ? value : [])
            : (value && Object.keys(value).length > 0 ? value : {});
        control.value = JSON.stringify(current, null, 2);
        control.oninput = () => { panelDraft.__jsonDirty = true; };
    } else if (field.type === 'conditions') {
        control = renderConditionsField(field);
    } else if (field.type === 'secret') {
        control = apiKeyInput(value ?? '', (v) => commitField(field, v), { placeholder: field.placeholder });
    } else if (field.type === 'platform') {
        control = el('input');
        control.type = 'text';
        control.value = formatPlatform(value);
        control.oninput = () => commitField(field, parsePlatform(control.value));
    } else if (field.type === 'checkbox') {
        control = el('input');
        control.type = 'checkbox';
        control.checked = value !== false;
        control.onchange = () => commitField(field, control.checked);
    } else if (field.type === 'select') {
        control = buildSelect(field, value);
        control.onchange = () => commitField(field, control.value);
    } else {
        control = el('input');
        control.type = 'text';
        control.value = value ?? '';
        if (field.maxLength) control.maxLength = field.maxLength;
        control.oninput = () => commitField(field, control.value);
    }
    if (field.placeholder) control.placeholder = field.placeholder;
    control.dataset.fieldKey = field.key;
    control.dataset.fieldType = field.type;
    const id = `domainField_${panelDomain.id}_${field.key}`;
    const idTarget = field.type === 'conditions'
        ? null
        : (control.matches?.('input,textarea,select')
            ? control
            : (control.querySelector?.('input,textarea,select') || control));
    if (idTarget && idTarget.id === '') idTarget.id = id;
    label.htmlFor = idTarget?.id || id;
    wrap.appendChild(control);
    // 字段级操作按钮（如「恢复预设提示词」）
    if (field.actionLabel && typeof field.onAction === 'function') {
        const actionRow = el('div', 'field-action');
        const actionBtn = el('button', 'btn btn-sm');
        actionBtn.type = 'button';
        actionBtn.textContent = field.actionLabel;
        actionBtn.id = `${id}_action`;
        actionBtn.onclick = () => {
            if (field.onAction(panelDraft)) renderEditorFields();
        };
        actionRow.appendChild(actionBtn);
        wrap.appendChild(actionRow);
    }
    if (field.note) {
        const note = el('div', 'field-note');
        note.textContent = field.note;
        wrap.appendChild(note);
    }
    return wrap;
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
    // JSON / 条件字段：保存时解析，错了就停在面板里
    for (const field of spec.fields) {
        if (field.type === 'conditions') {
            const control = $(`domainField_${spec.id}_${field.key}_json`);
            if (!control) continue;
            const result = parseConditions(field, control.value);
            if (!result.ok) {
                if (err) {
                    err.hidden = false;
                    err.textContent = `${field.label} 不合法：${result.error || 'JSON 无法解析'}`;
                }
                return;
            }
            draft[field.key] = result.value;
            continue;
        }
        if (field.type !== 'json') continue;
        const isArray = field.jsonKind === 'array';
        const control = $(`domainField_${spec.id}_${field.key}`);
        const raw = String(control?.value ?? '').trim();
        if (!raw) {
            draft[field.key] = isArray ? [] : {};
            continue;
        }
        try {
            const parsed = JSON.parse(raw);
            if (isArray) {
                if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组');
            } else if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
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
    // 导入迁移提示（如旧规则 on 数组取第一个、丢弃 name/toolChoice）留在页面上，避免只闪一下 toast
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    showFileMessage(spec, warnings.map(item => `${item.path} ${item.msg}`), '导入提示：');
    const suffix = warnings.length > 0 ? `（${warnings.length} 条迁移提示见下方）` : '';
    toast(`已导入 ${state.items.length} 个${spec.itemLabel}${suffix}`, 'ok');
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

function showFileMessage(spec, lines, titleText = '文件导入结果：') {
    const box = $(`${spec.id}FileMsg`);
    if (!box) return;
    box.innerHTML = '';
    if (!lines || lines.length === 0) {
        box.hidden = true;
        return;
    }
    const title = el('div', 'vtitle');
    title.textContent = titleText;
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

