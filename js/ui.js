// 各分区共用的 UI 元件：toast / 复制 / 下载 / 文件选择 / 导入对话框 / 卡片动作。
//
// 统一这些元素的原因：六个页签（模型 / 联网 / 角色 / 技能 / MCP / 知识库）的
// 卡片动作、工具栏和导入流程必须长得一样；否则用户每换一个页签都要重新找按钮。

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- toast / 剪贴板 / 文件

export function toast(msg, kind = '') {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = `toast ${kind}`.trim();
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { t.hidden = true; }, 3000);
}

export async function copyText(text) {
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

export function readFileText(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
        reader.readAsText(file, 'utf-8');
    });
}

export function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * 打开系统文件选择器。不插 DOM 的常驻 input，避免各页签重复写隐藏 input。
 * directory = true 时用目录选择器（webkitdirectory），用于技能目录批量导入。
 * @param {{accept?:string, multiple?:boolean, directory?:boolean, onFiles:(files:File[])=>void}} opts
 */
export function pickFiles(opts) {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    if (opts.directory) {
        // 目录选择时不能设 accept：否则浏览器会按扩展名过滤，连 SKILL.md 都可能选不中
        input.webkitdirectory = true;
        input.setAttribute('webkitdirectory', '');
        input.multiple = true;
    } else {
        input.accept = opts.accept || '.json';
        input.multiple = !!opts.multiple;
    }
    document.body.appendChild(input);
    input.addEventListener('change', () => {
        const picked = [...(input.files || [])];
        input.remove();
        const tooBig = picked.filter(f => f.size > 2 * 1024 * 1024);
        for (const f of tooBig) toast(`${f.name}：文件超过 2MB，已跳过`, 'err');
        const files = picked.filter(f => f.size <= 2 * 1024 * 1024);
        if (files.length > 0) opts.onFiles(files);
    });
    input.click();
}

// ---------------------------------------------------------------- 卡片动作

/**
 * 卡片底部统一的动作按钮：↑ ↓ 编辑 删除。
 * 六个页签的顺序、类名、title 全部一致；禁用逻辑由调用方给 index/total。
 *
 * @param {object} opts
 * @param {boolean} opts.canUp
 * @param {boolean} opts.canDown
 * @param {string} [opts.editLabel]
 * @param {() => void} opts.onUp
 * @param {() => void} opts.onDown
 * @param {() => void} opts.onEdit
 * @param {() => void} opts.onDelete
 * @returns {HTMLElement}
 */
export function cardActions(opts) {
    const wrap = document.createElement('div');
    wrap.className = 'pcard-actions';
    const up = actionBtn('↑', '上移', 'btn-move', !opts.canUp, opts.onUp);
    const down = actionBtn('↓', '下移', 'btn-move', !opts.canDown, opts.onDown);
    const edit = actionBtn(opts.editLabel || '编辑', '编辑', 'btn-edit', false, opts.onEdit);
    const del = actionBtn('删除', '删除', 'btn-danger', false, opts.onDelete);
    wrap.append(up, down, edit, del);
    return wrap;
}

function actionBtn(text, title, extraClass, disabled, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn-sm ${extraClass || ''}`.trim();
    btn.textContent = text;
    btn.title = title;
    btn.disabled = !!disabled;
    btn.onclick = onClick;
    return btn;
}

// ---------------------------------------------------------------- API Key / Token 输入

/**
 * 统一的密钥输入：密码框 + 显示/隐藏按钮（模型、联网、MCP Token 共用）。
 * @param {string} value
 * @param {(v:string)=>void} onChange
 * @param {{placeholder?:string}} [opts]
 * @returns {HTMLElement} 可直接放进 .field 的 .key-row
 */
export function apiKeyInput(value, onChange, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'key-row';
    const input = document.createElement('input');
    input.type = 'password';
    input.value = value ?? '';
    input.placeholder = opts.placeholder || 'sk-xxxxxxxx';
    input.autocomplete = 'new-password';
    input.spellcheck = false;
    input.oninput = () => onChange(input.value);
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'btn btn-sm';
    eye.textContent = '显示';
    eye.title = '显示/隐藏密钥';
    eye.onclick = () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        eye.textContent = show ? '隐藏' : '显示';
    };
    wrap.append(input, eye);
    return wrap;
}

// ---------------------------------------------------------------- 通用编辑侧栏

let sidePanelSave = null;
let sidePanelCancel = null;

function ensureSideEditor() {
    if ($('sidePanel')) return;
    const backdrop = document.createElement('div');
    backdrop.id = 'sideBackdrop';
    backdrop.className = 'backdrop';
    backdrop.hidden = true;
    backdrop.onclick = () => closeSideEditor(true);

    const panel = document.createElement('aside');
    panel.id = 'sidePanel';
    panel.className = 'panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.innerHTML = `
      <div class="panel-head">
        <h2 id="sidePanelTitle">编辑</h2>
        <button class="panel-x" id="sidePanelClose" type="button" title="关闭">×</button>
      </div>
      <div class="panel-body" id="sidePanelBody"></div>
      <div class="panel-foot">
        <button class="btn" id="sidePanelCancel" type="button">取消</button>
        <button class="btn btn-primary" id="sidePanelSave" type="button">保存</button>
      </div>`;
    document.body.append(backdrop, panel);
    $('sidePanelClose').onclick = () => closeSideEditor(true);
    $('sidePanelCancel').onclick = () => closeSideEditor(true);
    $('sidePanelSave').onclick = () => {
        const fn = sidePanelSave;
        closeSideEditor(false);
        if (fn) fn();
    };
}

/**
 * 统一的右侧编辑面板（与模型 / 内容分区的面板同一视觉）。
 * @param {{title:string, body:HTMLElement, onSave?:()=>void, onCancel?:()=>void, saveLabel?:string, cancelLabel?:string}} opts
 */
export function openSideEditor(opts) {
    ensureSideEditor();
    sidePanelSave = opts.onSave || null;
    sidePanelCancel = opts.onCancel || null;
    $('sidePanelTitle').textContent = opts.title || '编辑';
    $('sidePanelBody').innerHTML = '';
    if (opts.body) $('sidePanelBody').appendChild(opts.body);
    $('sidePanelSave').textContent = opts.saveLabel || '保存';
    $('sidePanelCancel').textContent = opts.cancelLabel || '取消';
    $('sideBackdrop').hidden = false;
    $('sidePanel').hidden = false;
}

export function closeSideEditor(cancelled = false) {
    if (!$('sidePanel')) return;
    const fn = cancelled ? sidePanelCancel : null;
    $('sidePanel').hidden = true;
    $('sideBackdrop').hidden = true;
    $('sidePanelBody').innerHTML = '';
    sidePanelSave = null;
    sidePanelCancel = null;
    if (fn) fn();
}

// ---------------------------------------------------------------- 导入对话框

let activeImporter = null;

/** 打开统一的导入对话框；parse 返回 {ok, issues}，成功时调用 onSuccess(result) */
export function openImportDialog(opts) {
    const panel = $('importPanel');
    if (!panel) return;
    activeImporter = {
        parse: opts.parse,
        onSuccess: opts.onSuccess,
    };
    $('importTitle').textContent = opts.title || '导入配置';
    const hint = panel.querySelector('.field-note');
    if (hint) hint.textContent = opts.hint || '粘贴一份已有配置；导入会替换当前内容，校验不通过时不会改动任何东西。';
    const textarea = $('importText');
    textarea.value = '';
    textarea.rows = opts.rows || 14;
    textarea.placeholder = opts.placeholder || '';
    $('importMsg').hidden = true;
    $('importMsg').textContent = '';
    $('importWarn').hidden = true;
    $('importWarn').textContent = '';
    panel.hidden = false;
    $('importBackdrop').hidden = false;
    textarea.focus();
}

export function closeImportDialog() {
    const panel = $('importPanel');
    if (!panel) return;
    panel.hidden = true;
    $('importBackdrop').hidden = true;
    $('importText').value = '';
    $('importMsg').hidden = true;
    $('importWarn').hidden = true;
    activeImporter = null;
}

export function importDialogOpen() {
    const panel = $('importPanel');
    return !!panel && !panel.hidden;
}

function showImportError(issues) {
    const box = $('importMsg');
    const list = Array.isArray(issues) ? issues : [];
    const lines = list.slice(0, 8).map(i => `${i.path} ${i.msg}`);
    if (list.length > 8) lines.push(`…还有 ${list.length - 8} 处`);
    box.textContent = '导入失败，未改动任何内容：\n' + lines.join('\n');
    box.hidden = false;
    $('importWarn').hidden = true;
}

function wireImportDialog() {
    const panel = $('importPanel');
    if (!panel) return;
    $('importClose').onclick = closeImportDialog;
    $('importCancel').onclick = closeImportDialog;
    $('importBackdrop').onclick = closeImportDialog;
    $('importConfirm').onclick = () => {
        if (!activeImporter) return;
        const text = $('importText').value;
        let result;
        try {
            result = activeImporter.parse(text);
        } catch (e) {
            showImportError([{ path: '$', msg: e instanceof Error ? e.message : String(e) }]);
            return;
        }
        if (!result || !result.ok) {
            showImportError(result && result.issues);
            return;
        }
        const importer = activeImporter;
        closeImportDialog();
        importer.onSuccess(result);
    };
}

// 模块在页面底部加载，此时导入面板已存在；不存在（单独加载模块的测试）则跳过
wireImportDialog();
