/* ============================================================
   后端桥接层
   ============================================================ */
(function () {
  const B = () => (window.go && window.go.main && window.go.main.App) || null;
  const RT = () => window.runtime || null;

  function call(name) {
    const args = Array.prototype.slice.call(arguments, 1);
    const b = B();
    if (!b || typeof b[name] !== 'function') {
      return Promise.reject(new Error('后端未就绪'));
    }
    return Promise.resolve(b[name].apply(b, args));
  }

  /** 统一错误提示的调用 */
  function safe(promise, label) {
    return promise.catch((e) => {
      UI.toast((label ? label + '：' : '') + (e && e.message ? e.message : String(e)), { type: 'error' });
      throw e;
    });
  }

  const API = {
    /* 环境 / 配置 */
    env: () => call('GetEnv'),
    getConfig: () => call('GetConfig'),
    setConfig: (cfg) => call('SetConfig', cfg),
    openDataDir: () => call('OpenDataDir'),
    reveal: (p) => call('RevealPath', p),
    quitApp: () => call('ForceQuit'),

    /* 选择器 */
    pickDir: (title, def) => call('PickDirectory', title || '选择目录', def || ''),
    pickFiles: (title) => call('PickFiles', title || '选择文件'),
    pickOpen: (title) => call('PickOpenPath', title || '导入列表'),
    pickSave: (name, desc, pat) => call('PickSavePath', name, desc, pat),
    inspectPaths: (paths) => call('InspectPaths', paths || []),

    /* 扫描 */
    startScan: (req) => call('StartScan', req),
    scanPage: (q) => call('ScanPage', q),
    scanGroups: (q) => call('ScanGroups', q),

    /* 查重 */
    startCheck: (req) => call('StartCheck', req),
    checkPage: (q) => call('CheckPage', q),
    checkAllMatched: (jobId) => call('CheckAllMatched', jobId),
    archiveCheck: (req) => call('ArchiveCheck', req),
    moveToTrash: (req) => call('MoveToTrash', req),

    /* 任务 */
    cancel: (jobId) => call('CancelJob', jobId),
    lastJob: (kind) => call('LastJob', kind),

    /* 列表 */
    listMetas: () => call('ListMetas'),
    listMeta: (id) => call('GetListMeta', id),
    listPage: (q) => call('ListPage', q),
    renameList: (id, name, note) => call('RenameList', id, name, note),
    deleteList: (id) => call('DeleteList', id),
    copyList: (id, name) => call('CopyList', id, name),
    mergeLists: (req) => call('MergeLists', req),
    exportList: (id, fmt, dest) => call('ExportList', id, fmt, dest),
    importList: (path) => call('ImportList', path),
    trashLog: (limit) => call('TrashLog', limit),
  };

  /* ------------------------------------------------ 事件 */
  const handlers = { progress: [], done: [], ready: [], beforeClose: [] };

  function on(kind, fn) { handlers[kind].push(fn); }

  function bind() {
    const rt = RT();
    if (!rt) return;
    rt.EventsOn('job:progress', (p) => handlers.progress.forEach((f) => f(p)));
    rt.EventsOn('job:done', (d) => handlers.done.forEach((f) => f(d)));
    rt.EventsOn('app:ready', (e) => handlers.ready.forEach((f) => f(e)));
    rt.EventsOn('app:beforeClose', () => handlers.beforeClose.forEach((f) => f()));
  }

  /* ------------------------------------------------ 全局状态 */
  const State = {
    env: null,
    config: null,
    lists: [],
    scan: { job: null, result: null, groups: [], running: false },
    check: { job: null, result: null, running: false, selection: new Set() },
    listsPage: { activeId: null, query: '', page: 0, layer: '', selection: new Set() },
    scanPage: { query: '', page: 0, filter: 'all', sort: 'path', desc: false, tab: 'files' },
    checkPage: { query: '', page: 0, filter: 'dup', sort: 'path', desc: false },
  };

  window.API = API;
  window.Bus = { on, bind };
  window.State = State;
  window.safe = safe;
})();
