/* ============================================================
   页面：目录扫描
   ============================================================ */
(function () {
  const { esc, num, bytes, duration, toast, dialog } = UI;
  const { statGrid, pagerHtml, bindPager, pathCell, searchBox, bindSearch, selectHtml, bindSelects, setSelectOptions } = W;

  // roots 元素：{ path, dir }，dir=false 表示单个文件
  function nowNote() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  const S = {
    roots: [], saveAs: '', note: nowNote(), baseListId: '',
    running: false, job: null, result: null, prog: null,
    tab: 'all', query: '', page: 0, sort: 'path', desc: false, page0Filter: 'all',
  };

  let host = null;
  let lastProgressAt = 0;

  /* ---------------------------------------------- 结构 */

  function shellHtml() {
    return '' +
      '<div class="card">' +
        '<div class="row gap-8">' + ICO('folder', 18) +
          '<span class="section-label">扫描目标</span>' +
          '<span class="spacer"></span>' +
          '<span class="t-body-sm muted">' + ICO('drop', 14) + ' 拖入文件夹或文件即可加入，可一次扫描多个</span>' +
        '</div>' +
        '<div class="row row--wrap gap-6 mt-8" id="scanRoots" style="min-height:34px"></div>' +
        '<div class="row gap-8 mt-12">' +
          '<div class="field grow">' +
            '<input id="scanAdd" placeholder=" " value="" style="padding-right:66px">' +
            '<label>添加目录或文件（回车确认）</label>' +
            '<div class="field-suffix">' +
              '<button class="icon-btn icon-btn--sm" id="btnScanPick" title="选择目录">' + ICO('folder', 18) + '</button>' +
              '<button class="icon-btn icon-btn--sm" id="btnScanPickFile" title="选择文件">' + ICO('file', 18) + '</button>' +
            '</div>' +
          '</div>' +
          '<button class="btn btn--text" id="btnScanClearRoots" style="flex:0 0 auto" title="清空已添加的目录与文件">' +
            ICO('close', 16) + '清空</button>' +
        '</div>' +
        '<div class="row row--wrap gap-16 mt-16">' +
          '<div class="field" style="width:230px"><input id="scanName" placeholder=" " value="' + esc(S.saveAs) + '"><label>列表名</label></div>' +
          '<div class="field grow" style="min-width:200px"><input id="scanNote" placeholder=" " value="' + esc(S.note) + '" title="留空则自动填入当前日期时间"><label>备注</label></div>' +
          selectHtml({ id: 'scanBase', label: '叠加到', value: S.baseListId, width: '230px', options: [['', '不叠加']] }) +
        '</div>' +
      '</div>' +

      '<div class="card hidden" id="scanProgCard">' +
        '<div class="row gap-12">' +
          '<span class="spinner"></span>' +
          '<span class="t-title-sm" id="scanPhase">扫描中</span>' +
          '<span class="spacer"></span>' +
          '<span class="t-body-sm muted" id="scanProgMeta"></span>' +
        '</div>' +
        '<div class="progress mt-12"><i id="scanProgBar" style="width:0"></i></div>' +
        '<div class="t-body-sm muted mt-8 truncate" id="scanProgCur"></div>' +
      '</div>' +

      '<div id="scanResult"></div>';
  }

  /* ---------------------------------------------- 扫描目标（目录 / 单文件，可多个） */

  function normRoot(p) {
    return String(p || '').trim().replace(/[\\/]+$/, '').toLowerCase();
  }

  function hasRoot(p) {
    const k = normRoot(p);
    return !!k && S.roots.some((x) => normRoot(x.path) === k);
  }

  function renderRoots() {
    const el = UI.$('#scanRoots', host);
    if (!el) return;
    const clr = UI.$('#btnScanClearRoots', host);
    if (clr) clr.disabled = !S.roots.length;
    if (!S.roots.length) {
      el.innerHTML = '<span class="t-body-sm muted">未添加 — 拖入文件夹或文件，或用下方输入框 / 按钮添加</span>';
      Shell.refreshActions();
      return;
    }
    el.innerHTML = S.roots.map((r, i) =>
      '<span class="chip chip--input">' + ICO(r.dir ? 'folder' : 'file', 16) +
      '<span class="truncate" style="max-width:320px" title="' + esc(r.path) + '">' + esc(r.path) + '</span>' +
      '<button class="icon-btn icon-btn--sm" data-rmroot="' + i + '" title="移除">' + ICO('close', 16) + '</button></span>').join('');
    UI.$$('[data-rmroot]', el).forEach((b) => {
      b.onclick = () => { S.roots.splice(Number(b.dataset.rmroot), 1); renderRoots(); };
    });
    Shell.refreshActions();
  }

  // 追加目标（自动去重），返回真正新增的个数。元素为 { path, dir } 或纯路径字符串
  function addRoots(list) {
    let added = 0;
    (list || []).forEach((it) => {
      const obj = (it && typeof it === 'object');
      const p = String(obj ? (it.path || '') : (it || '')).trim();
      if (!p || hasRoot(p)) return;
      S.roots.push({ path: p, dir: obj ? !!it.dir : true });
      added++;
    });
    if (added) renderRoots();
    return added;
  }

  function clearRoots() {
    S.roots = [];
    renderRoots();
  }

  // 输入框手填的路径：交给后端判定是目录还是文件
  function addTypedPath(p) {
    p = String(p || '').trim();
    if (!p) return;
    API.inspectPaths([p]).then((ks) => {
      const k = (ks || [])[0];
      const items = [{ path: p, dir: k ? !!k.dir : true }];
      if (!addRoots(items)) toast('该路径已在扫描目标中');
    }).catch(() => {
      if (!addRoots([{ path: p, dir: true }])) toast('该路径已在扫描目标中');
    });
  }

  /* ---------------------------------------------- 列表下拉 */

  function fillBaseSelect() {
    const opts = [['', '不叠加']].concat(State.lists.map((l) => [l.id, l.name + '（' + num(l.count) + '）']));
    if (S.baseListId && !State.lists.some((l) => l.id === S.baseListId)) S.baseListId = '';
    setSelectOptions(host, 'scanBase', opts, S.baseListId);
  }

  /* ---------------------------------------------- 进度 */

  function showProgress(on) {
    UI.$('#scanProgCard', host).classList.toggle('hidden', !on);
    S.running = on;
    Shell.refreshActions();
  }

  function updateProgress(p) {
    const now = Date.now();
    if (now - lastProgressAt < 100 && p.phase !== 'done') return;
    lastProgressAt = now;
    S.prog = p;
    const total = p.total || 0;
    const done = p.done || 0;
    const pct = p.phase === 'walking' ? 4 : total > 0 ? Math.min(100, (done / total) * 100) : 0;
    const bar = UI.$('#scanProgBar', host);
    if (bar) bar.style.width = pct.toFixed(1) + '%';
    const phase = UI.$('#scanPhase', host);
    if (phase) phase.textContent = p.phase === 'walking' ? '枚举文件' : '计算 MD5';
    const meta = UI.$('#scanProgMeta', host);
    if (meta) {
      const speed = p.elapsedMs > 0 ? (p.bytes / (p.elapsedMs / 1000)) : 0;
      meta.textContent = num(done) + (total ? ' / ' + num(total) : '') +
        '  ·  ' + bytes(p.bytes) + '  ·  ' + duration(p.elapsedMs) +
        (speed > 0 ? '  ·  ' + bytes(speed) + '/s' : '');
    }
    const cur = UI.$('#scanProgCur', host);
    if (cur && p.current) cur.textContent = p.current;
  }

  /* ---------------------------------------------- 结果 */

  function renderResult() {
    const box = UI.$('#scanResult', host);
    const r = S.result;
    if (!r) { box.innerHTML = ''; return; }
    if (!r.ok) {
      box.innerHTML = '<div class="card"><div class="row gap-12">' + ICO('alert', 22) +
        '<span>' + esc(r.error || '扫描失败') + '</span></div></div>';
      return;
    }

    const roots = (r.roots && r.roots.length) ? r.roots : (r.root ? [r.root] : []);
    const rootText = roots.length > 1
      ? roots.length + ' 个目录：' + roots.join('  +  ')
      : (roots[0] || '');

    box.innerHTML = '' +
      '<div class="card card--flush">' +
        '<div class="card-head">' + ICO('scan', 20) +
          '<h3>扫描结果</h3>' +
          (r.listId ? '<span class="tag tag--primary">' + ICO('save', 14) + esc(r.listName || '已存档') + '</span>' : '') +
          '<span class="spacer"></span>' +
          '<span class="t-body-sm muted truncate" style="max-width:420px" title="' + esc(roots.join('\n')) + '">' + esc(rootText) + '</span>' +
        '</div>' +
        '<div class="card-body">' +
          statGrid([
            { label: '文件总数', value: num(r.files) },
            { label: '唯一 MD5', value: num(r.unique) },
            { label: '重复组', value: num(r.groups), tone: r.groups ? 'tertiary' : '' },
            { label: '重复文件', value: num(r.dupFiles), tone: r.dupFiles ? 'error' : '' },
            { label: '可释放空间', value: bytes(r.waste), tone: r.waste ? 'error' : '' },
            { label: '总大小', value: bytes(r.totalSize) },
            { label: '增量复用', value: num(r.skipped) },
            { label: '耗时', value: duration(r.elapsedMs) },
          ]) +
        '</div>' +
        '<div class="tabs" id="scanTabs">' +
          '<button data-tab="all" class="' + (S.tab === 'all' ? 'selected' : '') + '">' + ICO('files', 18) + '全部<span class="tab-count">' + num(r.files) + '</span></button>' +
          '<button data-tab="dup" class="' + (S.tab === 'dup' ? 'selected' : '') + '">' + ICO('layers', 18) + '重复<span class="tab-count">' + num(r.dupFiles) + '</span></button>' +
          '<button data-tab="errors" class="' + (S.tab === 'errors' ? 'selected' : '') + '">' + ICO('alert', 18) + '错误<span class="tab-count">' + num(r.errors) + '</span></button>' +
        '</div>' +
        '<div class="card-body" style="padding-bottom:0">' +
          '<div class="row gap-8 row--wrap" id="scanToolbar"></div>' +
        '</div>' +
        '<div id="scanTable" class="table-wrap" style="max-height:52vh"></div>' +
        '<div id="scanPager"></div>' +
      '</div>';

    UI.$$('#scanTabs button', box).forEach((b) => {
      b.onclick = () => { S.tab = b.dataset.tab; S.page = 0; renderResult(); };
    });
    renderToolbar();
    loadTable();
  }

  function renderToolbar() {
    const tb = UI.$('#scanToolbar', host);
    if (!tb) return;
    // tabs 已按全部/重复/错误分好，toolbar 只放搜索框
    const ph = S.tab === 'errors' ? '搜索路径' : '搜索路径或 MD5';
    tb.innerHTML = '<span class="spacer"></span>' + searchBox(ph, S.query);
    bindSearch(tb, (v) => { S.query = v; S.page = 0; loadTable(); });
  }

  function loadTable() {
    if (!S.result || !S.result.jobId) return;
    const box = UI.$('#scanTable', host);
    if (S.tab === 'errors') {
      API.scanPage({
        key: S.result.jobId, offset: S.page, limit: 200, query: S.query,
        filter: 'error', sort: S.sort, desc: S.desc,
      }).then((pg) => {
        box.innerHTML = errorsTable(pg);
        bindTableEvents();
        bindPager(UI.$('#scanPager', host), pg, (o) => { S.page = o; loadTable(); });
      }).catch(() => {});
    } else {
      const filter = S.tab === 'dup' ? 'dup' : 'all';
      API.scanPage({
        key: S.result.jobId, offset: S.page, limit: 200, query: S.query,
        filter, sort: S.sort, desc: S.desc,
      }).then((pg) => {
        box.innerHTML = filesTable(pg);
        bindTableEvents();
        bindPager(UI.$('#scanPager', host), pg, (o) => { S.page = o; loadTable(); });
      }).catch(() => {});
    }
  }

  function groupsTable(pg) {
    if (!pg.total) return UI.emptyState('check', '没有重复文件');
    return '<table class="tbl"><thead><tr>' +
      '<th>MD5</th><th class="col-num">份数</th><th class="col-num">单份</th><th class="col-num">可释放</th><th>首个路径</th>' +
      '</tr></thead><tbody>' +
      pg.items.map((g) =>
        '<tr data-md5="' + esc(g.md5) + '" style="cursor:pointer">' +
        '<td class="mono md5 match">' + esc(g.md5) + '</td>' +
        '<td class="col-num">' + num(g.count) + '</td>' +
        '<td class="col-num">' + bytes(g.size) + '</td>' +
        '<td class="col-num on-error">' + bytes(g.waste) + '</td>' +
        '<td>' + pathCell(g.paths[0] ? g.paths[0].path : '') + '</td>' +
        '</tr>').join('') +
      '</tbody></table>';
  }

  function filesTable(pg) {
    if (!pg.total) return UI.emptyState('file', '没有匹配的文件');
    return '<table class="tbl"><thead><tr>' +
      '<th class="sortable" data-sort="path">路径</th>' +
      '<th class="sortable col-num" data-sort="size">大小</th>' +
      '<th class="sortable" data-sort="md5">MD5</th>' +
      '<th>状态</th></tr></thead><tbody>' +
      pg.items.map((r) =>
        '<tr>' +
        '<td>' + pathCell(r.path) + '</td>' +
        '<td class="col-num">' + bytes(r.size) + '</td>' +
        '<td class="mono md5">' + esc(r.md5 || '—') + '</td>' +
        '<td>' + (r.error ? '<span class="tag tag--warning">读取失败</span>'
          : r.dup ? '<span class="tag tag--error">重复 ×' + r.count + '</span>'
            : '<span class="tag">唯一</span>') + '</td>' +
        '</tr>').join('') +
      '</tbody></table>';
  }

  function errorsTable(pg) {
    if (!pg.total) return UI.emptyState('shield', '没有错误');
    return '<table class="tbl"><thead><tr><th>路径</th><th>错误</th></tr></thead><tbody>' +
      pg.items.map((r) => '<tr><td>' + pathCell(r.path) + '</td><td class="on-error">' + esc(r.error || '') + '</td></tr>').join('') +
      '</tbody></table>';
  }

  function bindTableEvents() {
    const box = UI.$('#scanTable', host);
    UI.$$('tr[data-md5]', box).forEach((tr) => {
      tr.onclick = () => showGroup(tr.dataset.md5);
    });
    UI.$$('th[data-sort]', box).forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.sort;
        if (S.sort === k) S.desc = !S.desc; else { S.sort = k; S.desc = false; }
        S.page = 0;
        loadTable();
      };
    });
  }

  function showGroup(md5) {
    const g = (S.result.groupsTop || []).find((x) => x.md5 === md5);
    if (!g) { toast('该分组详情未载入，请使用「全部文件」按 MD5 检索', { duration: 4000 }); return; }
    dialog({
      title: '重复文件组',
      icon: 'layers',
      wide: true,
      body: '<p class="mono selectable">' + esc(g.md5) + '</p>' +
        '<p>共 ' + num(g.count) + ' 个文件 · 单份 ' + bytes(g.size) + ' · 可释放 ' + bytes(g.waste) + '</p>' +
        '<div class="dialog-list">' + g.paths.map((p) =>
          '<div class="row"><span class="grow truncate selectable" title="' + esc(p.path) + '">' + esc(p.path) + '</span>' +
          '<button class="icon-btn icon-btn--sm" data-reveal="' + esc(p.path) + '" title="定位">' + ICO('external', 18) + '</button>' +
          '<button class="icon-btn icon-btn--sm" data-copy="' + esc(p.path) + '" title="复制路径">' + ICO('copy', 18) + '</button></div>').join('') +
        '</div>',
      actions: [{ label: '关闭', variant: 'text' }],
      onClose: () => {},
    });
    // 绑定（对话框已插入 DOM）
    UI.$$('[data-reveal]').forEach((b) => { b.onclick = () => API.reveal(b.dataset.reveal); });
    UI.$$('[data-copy]').forEach((b) => { b.onclick = () => UI.copyText(b.dataset.copy); });
  }

  /* ---------------------------------------------- 交互 */

  function bindForm() {
    UI.$('#btnScanPick', host).onclick = () => pickDir();
    UI.$('#btnScanPickFile', host).onclick = () => pickFiles();
    UI.$('#btnScanClearRoots', host).onclick = () => clearRoots();
    const addInp = UI.$('#scanAdd', host);
    addInp.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const v = addInp.value.trim();
      if (!v) return;
      addTypedPath(v);
      addInp.value = '';
    };
    UI.$('#scanName', host).oninput = (e) => { S.saveAs = e.target.value; };
    UI.$('#scanNote', host).oninput = (e) => { S.note = e.target.value; };
    // 若备注框为空，自动回填当前时间
    UI.$('#scanNote', host).onblur = (e) => {
      if (!e.target.value.trim()) { S.note = nowNote(); e.target.value = S.note; }
    };
    bindSelects(host, (id, v) => {
      if (id === 'scanBase') S.baseListId = v;
    });
  }

  function pickDir() {
    API.pickDir('选择要扫描的目录', S.roots.length ? S.roots[0].path : '').then((p) => {
      if (!p) return;
      if (!addRoots([{ path: p, dir: true }])) toast('该目录已在扫描目标中');
    }).catch(() => {});
  }

  function pickFiles() {
    API.pickFiles('选择要扫描的文件').then((ps) => {
      if (!ps || !ps.length) return;
      const added = addRoots(ps.map((p) => ({ path: p, dir: false })));
      if (!added) toast('这些文件已在扫描目标中');
    }).catch(() => {});
  }

  function start() {
    if (S.running) return;
    if (!S.roots.length) { toast('请先添加扫描目标（目录或文件）', { type: 'error' }); return; }
    S.result = null;
    S.query = ''; S.page = 0; S.tab = 'all'; S.page0Filter = 'all';
    UI.$('#scanResult', host).innerHTML = '';
    // 多个目录 / 文件一次扫描，结果合并为同一份；其余参数用内置默认值
    API.startScan({
      root: S.roots[0].path,
      roots: S.roots.map((r) => r.path),
      options: { minSize: 0, exclude: [], skipHidden: true },
      incremental: true,
      archive: true,
      saveAs: S.saveAs,
      note: S.note,
      baseListId: S.baseListId,
    }).then((r) => {
      if (!r.ok) { toast(r.error || '启动失败', { type: 'error' }); return; }
      S.job = r.jobId;
      showProgress(true);
      updateProgress({ phase: 'walking', done: 0, total: 0, bytes: 0, elapsedMs: 0 });
    }).catch(() => {});
  }

  function cancel() {
    if (!S.job) return;
    API.cancel(S.job).then((r) => toast(r.message || '已取消')).catch(() => {});
  }

  /* ---------------------------------------------- 拖入文件 / 目录 */

  // 拖入的文件直接作为扫描目标（单个文件也支持），目录按目录加入
  function onDrop(paths) {
    if (!paths || !paths.length) return;
    API.inspectPaths(paths).then((ks) => {
      const items = [];
      (ks || []).forEach((k) => {
        if (k.error) return;
        items.push({ path: k.path, dir: !!k.dir });
      });
      if (!items.length) { toast('未识别到可扫描的路径', { type: 'error' }); return; }
      const added = addRoots(items);
      if (!added) { toast('这些路径已在扫描目标中'); return; }
      const nf = items.filter((x) => !x.dir).length;
      toast('已加入 ' + num(added) + ' 个扫描目标' +
        (nf ? '（含 ' + num(nf) + ' 个文件）' : '') +
        (added < items.length ? '，其余重复已忽略' : ''));
    }).catch(() => {});
  }

  // 「重置」：清空扫描目标、结果与存档设置，回到初始状态
  function resetAll() {
    S.roots = [];
    S.result = null; S.job = null;
    S.query = ''; S.page = 0; S.tab = 'all'; S.page0Filter = 'all';
    S.saveAs = ''; S.note = nowNote(); S.baseListId = '';
    const box = UI.$('#scanResult', host);
    if (box) box.innerHTML = '';
    UI.$('#scanAdd', host).value = '';
    UI.$('#scanName', host).value = '';
    UI.$('#scanNote', host).value = '';
    fillBaseSelect();
    renderRoots();
    Shell.refreshActions();
  }

  function clearResult() {
    S.result = null;
    S.query = ''; S.page = 0; S.tab = 'all'; S.page0Filter = 'all';
    const box = UI.$('#scanResult', host);
    if (box) box.innerHTML = '';
    Shell.refreshActions();
  }

  /* ---------------------------------------------- 生命周期 */

  function mount(root) {
    host = root;
    host.innerHTML = shellHtml();
    bindForm();
    fillBaseSelect();
    renderRoots();
    if (S.result) renderResult();
    if (S.running) showProgress(true);
    Shell.refreshActions();
  }

  function onProgress(p) {
    if (!S.running || (S.job && p.jobId !== S.job)) return;
    updateProgress(p);
  }

  function onDone(d) {
    if (d.kind !== 'scan' || (S.job && d.jobId !== S.job)) return;
    S.job = null;
    showProgress(false);
    if (!d.ok && d.error) {
      toast(d.error, { type: 'error' });
      return;
    }
    S.result = d.scan;
    S.tab = 'all'; S.page = 0; S.query = '';
    renderResult();
    Shell.refreshActions();
    Shell.reloadLists().then(fillBaseSelect);
    if (d.scan && d.scan.listId) {
      toast('已存档到列表「' + d.scan.listName + '」', {
        actionLabel: '查看', onAction: () => Shell.go('lists', d.scan.listId),
      });
    }
  }

  window.Pages = window.Pages || {};
  window.Pages.scan = {
    id: 'scan', title: '目录扫描', subtitle: '递归计算文件 MD5 并归档为列表', icon: 'scan',
    mount,
    unmount() { host = null; },
    onProgress,
    onDone,
    onDrop,
    dropHint() { return '松开即把这些文件夹 / 文件加入扫描目标'; },
    isRunning() { return S.running; },
    // 页面功能按钮统一放在底部功能区
    actions() {
      const a = [
        {
          id: 'reset', label: '重置', icon: 'refresh', variant: 'text',
          title: '清空扫描目标、结果与存档设置',
          disabled: S.running || (!S.roots.length && !S.result), onClick: resetAll,
        },
        { id: 'clear', label: '清空结果', icon: 'filter', variant: 'text', disabled: !S.result, onClick: clearResult },
      ];
      a.push(S.running
        ? { id: 'cancel', label: '取消扫描', icon: 'stop', variant: 'outlined', onClick: cancel }
        : { id: 'start', label: '开始扫描', icon: 'play', variant: 'filled', onClick: start });
      return a;
    },
    reset() { S.result = null; S.job = null; S.running = false; },
    status() {
      if (S.running) return '<span class="spinner spinner--sm"></span><span class="ab-text">扫描进行中…</span>';
      const r = S.result;
      if (r && r.ok) {
        const n = (r.roots && r.roots.length) || 1;
        return ICO('scan', 14) + '<span class="ab-text">上次扫描：' + num(r.files) + ' 个文件 · 重复组 ' + num(r.groups) +
          ' · 可释放 ' + bytes(r.waste) + (n > 1 ? ' · ' + n + ' 个目标' : '') + '</span>';
      }
      if (!S.roots.length) {
        return ICO('folder', 14) + '<span class="ab-text">请添加扫描目标（可拖入多个文件夹或文件，结果合并为一份）</span>';
      }
      const nf = S.roots.filter((x) => !x.dir).length;
      return ICO('folder', 14) + '<span class="ab-text">已添加 ' + num(S.roots.length) + ' 个扫描目标' +
        (nf ? '（含 ' + num(nf) + ' 个文件）' : '') +
        (S.roots.length === 1 ? '：' + esc(S.roots[0].path) : '') + '</span>';
    },
  };
})();
