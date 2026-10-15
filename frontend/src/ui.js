/* ============================================================
   通用 UI 组件：菜单（多级）/ 对话框 / Snackbar / 格式化
   ============================================================ */
(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 100 ? n.toFixed(0) : n.toFixed(n >= 10 ? 1 : 2)) + ' ' + u[i];
  }

  function num(n) { return (Number(n) || 0).toLocaleString('zh-CN'); }

  function duration(ms) {
    ms = Number(ms) || 0;
    if (ms < 1000) return ms + ' ms';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + ' s';
    const m = Math.floor(s / 60);
    return m + ' 分 ' + Math.round(s - m * 60) + ' 秒';
  }

  function fmtTime(v) {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function relTime(v) {
    if (!v) return '';
    const t = new Date(v).getTime();
    if (isNaN(t)) return String(v);
    const diff = Date.now() - t;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 604800000) return Math.floor(diff / 86400000) + ' 天前';
    return fmtTime(v);
  }

  function splitPath(p) {
    const i = Math.max(String(p).lastIndexOf('\\'), String(p).lastIndexOf('/'));
    if (i < 0) return { dir: '', name: p };
    return { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
  }

  function debounce(fn, wait) {
    let t = 0;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), wait || 220);
    };
  }

  /* ------------------------------------------------ Snackbar */
  let snackHost = null;
  function toast(msg, opt) {
    opt = opt || {};
    if (!snackHost) {
      snackHost = document.createElement('div');
      snackHost.className = 'snack-host';
      document.body.appendChild(snackHost);
    }
    const el = document.createElement('div');
    el.className = 'snack' + (opt.type === 'error' ? ' snack--error' : '');
    el.innerHTML =
      ICO(opt.type === 'error' ? 'alert' : 'info', 20) +
      '<span class="snack-msg">' + esc(msg) + '</span>' +
      (opt.actionLabel ? '<button class="snack-action">' + esc(opt.actionLabel) + '</button>' : '');
    snackHost.appendChild(el);
    const kill = () => {
      el.style.transition = 'opacity .15s ease';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 160);
    };
    if (opt.actionLabel) {
      $('.snack-action', el).onclick = () => { kill(); if (opt.onAction) opt.onAction(); };
    }
    const dur = opt.duration || (opt.actionLabel ? 6000 : 3200);
    setTimeout(kill, dur);
    return el;
  }

  /* ------------------------------------------------ 对话框 */
  let openDialogs = [];
  function dialog(cfg) {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    const wide = cfg.wide ? ' dialog--wide' : '';
    scrim.innerHTML =
      '<div class="dialog' + wide + '" role="dialog" aria-modal="true">' +
      (cfg.icon ? '<div class="dialog-icon">' + ICO(cfg.icon, 28) + '</div>' : '') +
      (cfg.title ? '<h2>' + esc(cfg.title) + '</h2>' : '') +
      (cfg.body || '') +
      '<div class="dialog-actions"></div>' +
      '</div>';
    const box = $('.dialog', scrim);
    const actions = $('.dialog-actions', scrim);
    const api = {
      el: box,
      close(result) {
        scrim.remove();
        openDialogs = openDialogs.filter((d) => d !== api);
        if (cfg.onClose) cfg.onClose(result);
      },
    };
    (cfg.actions || [{ label: '关闭' }]).forEach((a) => {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.variant === 'filled' ? 'btn--filled'
        : a.variant === 'danger' ? 'btn--danger'
          : a.variant === 'tonal' ? 'btn--tonal'
            : a.variant === 'outlined' ? 'btn--outlined' : 'btn--text');
      b.textContent = a.label;
      b.onclick = () => {
        if (a.onClick) {
          const r = a.onClick(api, box);
          if (r === false) return;
        }
        if (a.keepOpen !== true) api.close(a.value);
      };
      actions.appendChild(b);
    });
    scrim.addEventListener('mousedown', (e) => {
      if (e.target === scrim && cfg.dismissible !== false) api.close();
    });
    document.body.appendChild(scrim);
    openDialogs.push(api);
    if (cfg.onMount) cfg.onMount(box, api);
    setTimeout(() => {
      const f = $('input,textarea,select', box);
      if (f) f.focus();
    }, 40);
    return api;
  }

  function confirmDialog(cfg) {
    return new Promise((resolve) => {
      let settled = false;
      dialog({
        title: cfg.title,
        icon: cfg.icon || 'alert',
        body: '<p>' + (cfg.html || esc(cfg.message || '')) + '</p>' + (cfg.extra || ''),
        actions: [
          { label: cfg.cancelLabel || '取消', onClick: () => { settled = true; resolve(false); } },
          {
            label: cfg.confirmLabel || '确定',
            variant: cfg.danger ? 'danger' : 'filled',
            onClick: () => { settled = true; resolve(true); },
          },
        ],
        onClose: () => { if (!settled) resolve(false); },
      });
    });
  }

  /* ------------------------------------------------ 菜单（支持多级） */
  let menuStack = [];
  let menuScrim = null;

  // 记录最后的指针位置：锚点失效（例如元素已被重绘替换）时用来兜底定位
  const lastPointer = { x: 0, y: 0 };
  document.addEventListener('mousemove', (e) => {
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;
  }, { passive: true });

  function closeMenus() {
    menuStack.forEach((m) => m.remove());
    menuStack = [];
    if (menuScrim) { menuScrim.remove(); menuScrim = null; }
  }

  function buildMenu(items, level, opts) {
    opts = opts || {};
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.dataset.level = String(level);
    renderItems(menu, items, level, opts);
    return menu;
  }

  /**
   * 渲染菜单条目。
   * 支持三种形态：{divider} / {header, items:[...]} 分组 / 普通条目
   */
  function renderItems(menu, items, level, opts) {
    (items || []).forEach((it) => {
      if (it.divider) {
        const d = document.createElement('div');
        d.className = 'menu-divider';
        menu.appendChild(d);
        return;
      }
      // 分组：先渲染组标题，再展开组内条目
      if (Array.isArray(it.items)) {
        if (it.header) {
          const h = document.createElement('div');
          h.className = 'menu-header';
          h.textContent = it.header;
          menu.appendChild(h);
        }
        renderItems(menu, it.items, level, opts);
        return;
      }
      if (it.header) {
        const h = document.createElement('div');
        h.className = 'menu-header';
        h.textContent = it.header;
        menu.appendChild(h);
        return;
      }
      const row = document.createElement('div');
      row.className = 'menu-item' + (it.danger ? ' danger' : '');
      if (it.key) row.dataset.mi = it.key;
      if (it.disabled) row.setAttribute('disabled', '');
      row.innerHTML =
        (it.icon ? ICO(it.icon, 20) : '<span style="width:20px"></span>') +
        '<span class="menu-text">' + esc(it.label) + '</span>' +
        (it.hint ? '<span class="menu-hint">' + esc(it.hint) + '</span>' : '') +
        (it.submenu ? ICO('chevRight', 18, 'chev') : '');
      row.addEventListener('mouseenter', () => {
        while (menuStack.length > level + 1) menuStack.pop().remove();
        if (it.submenu) openSub(it, row, level, opts);
      });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (it.submenu) { openSub(it, row, level, opts); return; }
        if (it.disabled) return;
        if (!opts.sticky) closeMenus();
        if (it.onSelect) it.onSelect(row);
      });
      menu.appendChild(row);
    });
  }

  function openSub(it, row, level, opts) {
    const items = typeof it.submenu === 'function' ? it.submenu() : it.submenu;
    const sub = buildMenu(items, level + 1, opts);
    document.body.appendChild(sub);
    positionMenu(sub, row, true);
    menuStack.push(sub);
  }

  // 解析锚点：元素 / 点坐标 {x,y} / 已脱离文档的元素（退化成指针位置）
  function anchorRect(anchor) {
    if (anchor && typeof anchor.x === 'number' && typeof anchor.y === 'number' &&
        typeof anchor.getBoundingClientRect !== 'function') {
      const x = anchor.x, y = anchor.y;
      return { left: x, top: y, right: x, bottom: y, width: 0, height: 0 };
    }
    if (anchor && typeof anchor.getBoundingClientRect === 'function') {
      const r = anchor.getBoundingClientRect();
      // 全 0 说明元素已经不在文档里（父级 innerHTML 被重绘过），此时不能用
      if (r.width || r.height || r.left || r.top) return r;
    }
    const x = lastPointer.x, y = lastPointer.y;
    return { left: x, top: y, right: x, bottom: y, width: 0, height: 0 };
  }

  function positionMenu(menu, anchor, isSub) {
    const r = anchorRect(anchor);
    const mw = menu.offsetWidth || 220;
    const mh = menu.offsetHeight || 200;
    let left, top;
    if (isSub) {
      left = r.right + 4;
      top = r.top - 8;
      if (left + mw > window.innerWidth - 8) left = r.left - mw - 4;
    } else {
      left = r.left;
      top = r.bottom + 6;
      if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
      if (left < 8) left = 8;
    }
    if (top + mh > window.innerHeight - 8) {
      top = isSub ? Math.max(8, r.bottom - mh) : Math.max(8, r.top - mh - 6);
    }
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
  }

  function showMenu(anchor, items, opts) {
    opts = opts || {};
    closeMenus();
    menuScrim = document.createElement('div');
    menuScrim.className = 'menu-scrim';
    menuScrim.addEventListener('mousedown', closeMenus);
    menuScrim.addEventListener('contextmenu', (e) => { e.preventDefault(); closeMenus(); });
    document.body.appendChild(menuScrim);
    const menu = buildMenu(items, 0, opts);
    document.body.appendChild(menu);
    positionMenu(menu, anchor, false);
    menuStack.push(menu);
    return menu;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (menuStack.length) { closeMenus(); return; }
      if (openDialogs.length) { openDialogs[openDialogs.length - 1].close(); }
    }
  });

  /* ------------------------------------------------ 小工具 */
  function confirmTrash(n, sizeTxt) {
    return confirmDialog({
      title: '移入回收站',
      icon: 'trash',
      danger: true,
      html: '将把 <b>' + num(n) + '</b> 个文件（约 <b>' + esc(sizeTxt) + '</b>）移入系统回收站。<br>文件可从回收站还原。',
      confirmLabel: '移入回收站',
    });
  }

  function emptyState(iconName, title, sub) {
    return '<div class="empty">' + ICO(iconName, 40) +
      '<div class="empty-title">' + esc(title) + '</div>' +
      (sub ? '<div class="t-body-sm">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function copyText(text) {
    navigator.clipboard.writeText(text).then(
      () => toast('已复制'),
      () => toast('复制失败', { type: 'error' })
    );
  }

  window.UI = {
    $, $$, esc, bytes, num, duration, fmtTime, relTime, splitPath, debounce,
    toast, dialog, confirmDialog, confirmTrash, showMenu, closeMenus,
    emptyState, copyText,
  };
})();
