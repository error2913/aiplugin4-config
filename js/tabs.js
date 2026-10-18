// 统一页签切换。
//
// 背景：原来 model / web 两个分区各自抢 setView，新增四个内容分区后必须收口到一处，
// 否则点「模型配置」只会隐藏 model/web，内容分区仍然显示。
//
// 约定：每个 view 注册一个 layout 元素（hidden 切换）与可选 onShow 回调；
// 导航按钮统一用 [data-view] 标记。
const views = new Map();
let current = null;
let wired = false;
/** 地址栏希望打开的页签；可能比分区模块先确定（模块按顺序加载） */
let pendingWanted = null;

export function registerView(id, layout, onShow) {
    views.set(id, { layout, onShow: typeof onShow === 'function' ? onShow : null });
    // 分区模块通常晚于 web-app.js 加载：等它注册上再切，避免深链落到默认页
    if (pendingWanted === id && current !== id) showView(id);
}

export function showView(id) {
    if (!views.has(id)) return;
    current = id;
    for (const [key, view] of views) {
        if (view.layout) view.layout.hidden = key !== id;
    }
    document.querySelectorAll('[data-view]').forEach((btn) => {
        const on = btn.dataset.view === id;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', String(on));
    });
    const view = views.get(id);
    if (view && view.onShow) view.onShow();
}

export function currentView() {
    return current;
}

/** 绑定导航按钮与初始页签（只执行一次） */
export function initTabs() {
    if (wired) return;
    wired = true;
    document.querySelectorAll('[data-view]').forEach((btn) => {
        btn.addEventListener('click', () => showView(btn.dataset.view));
    });
    const params = new URLSearchParams(location.search);
    const hash = location.hash ? location.hash.replace(/^#/, '') : '';
    pendingWanted = params.get('tab') || hash || 'model';
    if (views.has(pendingWanted)) {
        showView(pendingWanted);
        return;
    }
    // 后加载的分区模块注册时会直接切；这里只做兜底（模块加载失败 / 地址拼错）
    let tries = 0;
    const tick = () => {
        if (views.has(pendingWanted)) {
            showView(pendingWanted);
            return;
        }
        if (++tries <= 20) {
            setTimeout(tick, 25);
        } else {
            showView('model');
        }
    };
    setTimeout(tick, 0);
}
