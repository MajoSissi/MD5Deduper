/* ============================================================
   应用外壳：左侧导航 · 顶部应用栏 · 窗口按钮 · 底部功能区 · 路由 · 拖放
   ============================================================ */
(function () {
  const { esc, num, bytes, fmtTime, toast, dialog, confirmDialog } = UI;

  const RAIL = [
    { id: 'scan', label: '扫描', icon: 'scan' },
    { id: 'check', label: '查重', icon: 'target' },
    { id: 'lists', label: '列表', icon: 'layers' },
    { id: 'settings', label: '设置', icon: 'sliders' },
  ];

  let currentId = 'scan';
  let maxSyncTimer = 0;

  const RT = () => window.runtime || null;

  /* ---------------------------------------------- 主题 */

  // 主题固定为深色（MD3 经典蓝），不提供外观设置项。
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  /* ---------------------------------------------- 数据 */

  function reloadLists() {
    return API.listMetas().then((ms) => {
      State.lists = ms || [];
      return State.lists;
    }).catch(() => { State.lists = []; return []; });
  }

  function applyConfig() {
    const active = Pages[currentId];
    if (active && active.refresh && currentId === 'settings') active.refresh();
  }

  function anyRunning() {
    return ['scan', 'check'].some((k) => Pages[k] && Pages[k].isRunning && Pages[k].isRunning());
  }

  /* ---------------------------------------------- 左侧导航 */

  function renderRail() {
    const el = document.getElementById('rail');
    el.innerHTML =
      '<div class="rail-logo" aria-hidden="true">' + LOGO(60) + '</div>' +
      RAIL.map((r) =>
        '<button class="rail-item' + (r.id === currentId ? ' active' : '') + '" data-nav="' + r.id + '" title="' + esc(r.label) + '">' +
        '<span class="rail-ind">' + ICO(r.icon, 22) + '</span>' +
        '<span class="rail-label">' + esc(r.label) + '</span></button>').join('') +
      '<div class="rail-spacer"></div>' +
      '<button class="rail-item" id="railData" title="打开数据目录">' +
        '<span class="rail-ind">' + ICO('database', 22) + '</span>' +
        '<span class="rail-label">数据</span></button>';

    UI.$$('[data-nav]', el).forEach((b) => { b.onclick = () => go(b.dataset.nav); });
    document.getElementById('railData').onclick = () => API.openDataDir().catch(() => toast('打开失败', { type: 'error' }));
  }

  /* ---------------------------------------------- 顶部应用栏 */

  function renderAppbar() {
    const p = Pages[currentId];
    const bar = document.getElementById('appbar');
    bar.innerHTML =
      '<div class="appbar-title">' +
        '<span class="t-title truncate">' + esc(p.title) + '</span>' +
        '<span class="t-body-sm muted truncate">' + esc(p.subtitle || '') + '</span>' +
      '</div>' +
      '<div class="win-controls" id="winControls">' +
        '<button class="win-btn" data-win="min" title="最小化">' + ICO('winMin', 16) + '</button>' +
        '<button class="win-btn" data-win="max" title="最大化">' + ICO('winMax', 14) + '</button>' +
        '<button class="win-btn close" data-win="close" title="关闭">' + ICO('close', 16) + '</button>' +
      '</div>';

    UI.$$('[data-win]', bar).forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const k = b.dataset.win;
        const rt = RT();
        if (k === 'min') { if (rt) rt.WindowMinimise(); }
        else if (k === 'max') { if (rt) rt.WindowToggleMaximise(); setTimeout(syncMaxIcon, 60); }
        else closeWindow();
      };
    });
    bar.ondblclick = (e) => {
      if (e.target.closest('button')) return;
      const rt = RT();
      if (rt) rt.WindowToggleMaximise();
      setTimeout(syncMaxIcon, 60);
    };
    syncMaxIcon();
    refreshActions();
  }

  function syncMaxIcon() {
    const rt = RT();
    const b = UI.$('[data-win="max"]');
    if (!b) return;
    if (!rt || !rt.WindowIsMaximised) return;
    rt.WindowIsMaximised().then((m) => {
      const btn = UI.$('[data-win="max"]');
      if (!btn) return;
      btn.innerHTML = ICO(m ? 'winRestore' : 'winMax', 14);
      btn.title = m ? '向下还原' : '最大化';
    }).catch(() => {});
  }

  function refreshActions() {
    const p = Pages[currentId];
    const box = document.getElementById('actionbarActions');
    const acts = (p && p.actions) ? (p.actions() || []) : [];
    if (box) {
      box.innerHTML = acts.map((a) => {
        if (a.divider) return '<span class="ab-sep"></span>';
        return '<button class="btn btn--' + (a.variant || 'text') + '" data-act="' + a.id + '"' +
          (a.disabled ? ' disabled' : '') + (a.title ? ' title="' + esc(a.title) + '"' : '') + '>' +
          (a.icon ? ICO(a.icon, 16) : '') + esc(a.label) + '</button>';
      }).join('');
      acts.forEach((a) => {
        if (a.divider) return;
        const b = UI.$('[data-act="' + a.id + '"]', box);
        if (b && a.onClick) b.onclick = a.onClick;
      });
    }
    const st = document.getElementById('abStatus');
    if (st) {
      const txt = (p && p.status) ? (p.status() || '') : '';
      st.innerHTML = txt;
    }
  }

  /* ---------------------------------------------- 回收站日志 */

  function showTrashLog() {
    API.trashLog(300).then((items) => {
      dialog({
        title: '回收站日志',
        icon: 'history',
        wide: true,
        body: items.length
          ? '<div class="dialog-list" style="max-height:380px"><table class="tbl"><thead><tr>' +
            '<th>时间</th><th>文件</th><th class="col-num">大小</th><th>命中列表</th></tr></thead><tbody>' +
            items.map((it) =>
              '<tr><td class="nowrap">' + esc(fmtTime(it.time)) + '</td>' +
              '<td class="selectable" style="max-width:360px;overflow-wrap:anywhere">' + esc(it.path) + '</td>' +
              '<td class="col-num">' + bytes(it.size) + '</td>' +
              '<td>' + esc(it.source || '—') + '</td></tr>').join('') +
            '</tbody></table></div>'
          : '<p>暂无记录</p>',
        actions: [{ label: '关闭', variant: 'filled' }],
      });
    }).catch(() => toast('读取日志失败', { type: 'error' }));
  }

  // 退出：先请后端标记「已确认退出」，避免 OnBeforeClose 再次拦截；后端不可用时退回原生退出
  function doQuit() {
    const fallback = () => {
      const rt = RT();
      if (rt && rt.Quit) rt.Quit();
      else window.close();
    };
    const p = API.quitApp();
    if (p && p.catch) p.catch(fallback);
  }

  function closeWindow() {
    if (!anyRunning()) { doQuit(); return; }
    confirmDialog({
      title: '任务正在执行',
      icon: 'alert',
      html: '仍有扫描或查重任务在进行，退出会中断任务。确定退出程序吗？',
      confirmLabel: '退出',
    }).then((ok) => { if (ok) doQuit(); });
  }

  /* ---------------------------------------------- 路由 */

  function rerenderPage() {
    const view = document.getElementById('view');
    const p = Pages[currentId];
    view.scrollTop = 0;
    view.innerHTML = '<div class="view-inner" id="pageRoot"></div>';
    p.mount(document.getElementById('pageRoot'));
    renderAppbar();
    renderRail();
  }

  function go(id, arg) {
    if (!Pages[id]) return;
    if (Pages[currentId] && Pages[currentId].unmount && currentId !== id) Pages[currentId].unmount();
    currentId = id;
    setDropHint(false);
    rerenderPage();
    if (arg && Pages[id].select) Pages[id].select(arg);
  }

  /* ---------------------------------------------- 拖放（文件 / 目录） */

  let dragDepth = 0;

  function dropPage() {
    const p = Pages[currentId];
    return (p && p.onDrop) ? p : null;
  }

  function setDropHint(on) {
    const el = document.getElementById('dropHint');
    if (!el) return;
    if (on) {
      const p = dropPage();
      const t = UI.$('.dh-text', el);
      if (t) t.textContent = (p && p.dropHint) ? p.dropHint() : '松开以加入';
    }
    el.classList.toggle('show', !!on);
  }

  function initDrop() {
    const rt = RT();
    if (rt && rt.OnFileDrop) {
      rt.OnFileDrop((x, y, paths) => {
        dragDepth = 0;
        setDropHint(false);
        const p = dropPage();
        if (!p) { toast('当前页面不支持拖入文件', { type: 'error' }); return; }
        if (paths && paths.length) p.onDrop(paths);
      }, true);
    }
    document.addEventListener('dragenter', (e) => {
      if (!dropPage()) return;
      dragDepth++;
      setDropHint(true);
    });
    document.addEventListener('dragover', (e) => {
      if (!dropPage()) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) setDropHint(false);
    });
    document.addEventListener('drop', (e) => {
      dragDepth = 0;
      setDropHint(false);
      if (dropPage()) e.preventDefault();
    });
    window.addEventListener('blur', () => { dragDepth = 0; setDropHint(false); });
  }

  /* ---------------------------------------------- 事件 */

  function onProgress(p) {
    const pg = Pages[p.kind === 'scan' ? 'scan' : 'check'];
    if (pg && pg.onProgress) pg.onProgress(p);
  }

  function onDone(d) {
    const pg = Pages[d.kind === 'scan' ? 'scan' : 'check'];
    if (pg && pg.onDone) pg.onDone(d);
  }

  /* ---------------------------------------------- 启动 */

  function boot() {
    document.getElementById('app').innerHTML =
      '<nav class="rail" id="rail"></nav>' +
      '<main class="main">' +
        '<header class="appbar" id="appbar"></header>' +
        '<div class="view" id="view"></div>' +
        '<footer class="actionbar" id="actionbar">' +
          '<div class="ab-status" id="abStatus"></div>' +
          '<div class="ab-actions" id="actionbarActions"></div>' +
        '</footer>' +
      '</main>' +
      '<div class="drop-hint" id="dropHint">' +
        '<div class="drop-box">' + ICO('drop', 40) +
          '<div class="dh-title">拖入文件或文件夹</div>' +
          '<div class="dh-text t-body-sm muted">松开以加入</div>' +
        '</div>' +
      '</div>';

    Bus.bind();
    Bus.on('progress', onProgress);
    Bus.on('done', onDone);
    // 有任务在跑时用原生方式关闭（Alt+F4 / 系统菜单）会先拦下来，这里弹确认框
    Bus.on('beforeClose', closeWindow);

    applyTheme();
    renderRail();
    initDrop();
    window.addEventListener('resize', () => {
      clearTimeout(maxSyncTimer);
      maxSyncTimer = setTimeout(syncMaxIcon, 120);
    });

    API.env().then((e) => { State.env = e; })
      .catch(() => {})
      .then(() => API.getConfig())
      .then((c) => {
        State.config = c || {};
        return reloadLists();
      })
      .then(() => {
        applyConfig();
        const hash = (location.hash || '').replace(/^#/, '');
        go(Pages[hash] ? hash : 'scan');
        renderRail();
        const s = State.lists.reduce((a, b) => a + (b.count || 0), 0);
        if (State.lists.length) {
          toast('已载入 ' + num(State.lists.length) + ' 个列表 · ' + num(s) + ' 条记录', { duration: 2600 });
        }
      })
      .catch((e) => {
        go(Pages[(location.hash || '').replace(/^#/, '')] ? location.hash.replace(/^#/, '') : 'scan');
        toast('初始化失败：' + (e && e.message ? e.message : e), { type: 'error', duration: 6000 });
      });
  }

  window.Shell = {
    go, reloadLists, applyConfig, refreshActions, showTrashLog,
    get current() { return currentId; },
  };

  document.addEventListener('DOMContentLoaded', boot);
})();
