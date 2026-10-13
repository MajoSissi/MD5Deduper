/* ============================================================
   页面：设置
   ============================================================ */
(function () {
  const { esc, toast } = UI;
  const { selectHtml, bindSelects, selValue } = W;

  const S = { cfg: null, env: null };
  let host = null;

  function shellHtml() {
    const c = S.cfg || {};
    const e = S.env || {};
    const conc = c.concurrency || 0;
    return '' +
      '<div class="card">' +
        '<div class="row gap-12">' + ICO('zap', 20) + '<span class="t-title-sm">性能</span></div>' +
        '<div class="row row--wrap gap-16 mt-16">' +
          selectHtml({
            id: 'setConc', label: '并发数', value: conc, width: '220px',
            options: [['0', '自动（' + (e.numCPU || 0) + ' 核）']]
              .concat([1, 2, 4, 6, 8, 12, 16].map((n) => [String(n), n + ' 线程'])),
          }) +
          selectHtml({
            id: 'setPage', label: '每页条数', value: c.pageSize || 100, width: '180px',
            options: [50, 100, 200, 500].map((n) => [String(n), n + ' 条']),
          }) +
        '</div>' +
        '<div class="t-body-sm muted mt-8">扫描与查重一律递归子目录、跳过隐藏文件、自动存档为列表。</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="row gap-12">' + ICO('database', 20) + '<span class="t-title-sm">数据</span>' +
          '<span class="spacer"></span>' +
          '<span class="t-body-sm muted">打开数据目录 / 回收站日志见下方功能区</span>' +
        '</div>' +
        '<div class="kv mt-16">' +
          '<dt>数据目录</dt><dd class="selectable mono">' + esc(e.dataDir || '—') + '</dd>' +
          '<dt>程序目录</dt><dd class="selectable mono">' + esc(e.exeDir || '—') + '</dd>' +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="row gap-12">' + ICO('info', 20) + '<span class="t-title-sm">关于</span></div>' +
        '<div class="kv mt-16">' +
          '<dt>版本</dt><dd>' + esc(e.version || '—') + '</dd>' +
          '<dt>平台</dt><dd>' + esc(e.os || '—') + ' · ' + (e.numCPU || 0) + ' 核</dd>' +
          '<dt>存储</dt><dd>列表以 JSON 存放于 <span class="mono">data/lists</span>，回收站操作记录于 <span class="mono">data/trash-log.jsonl</span></dd>' +
        '</div>' +
      '</div>';
  }

  function collect() {
    const c = Object.assign({}, S.cfg);
    c.concurrency = Number(selValue(host, 'setConc')) || 0;
    c.pageSize = Number(selValue(host, 'setPage')) || 100;
    return c;
  }

  function save() {
    const c = collect();
    API.setConfig(c).then(() => {
      State.config = c;
      S.cfg = c;
      Shell.applyConfig();
      toast('设置已保存');
    }).catch((e) => toast('保存失败：' + (e.message || e), { type: 'error' }));
  }

  function mount(root) {
    host = root;
    S.cfg = State.config || {};
    S.env = State.env || {};
    host.innerHTML = shellHtml();
    bindSelects(host);
    Shell.refreshActions();
  }

  window.Pages = window.Pages || {};
  window.Pages.settings = {
    id: 'settings', title: '设置', subtitle: '性能 · 数据 · 关于', icon: 'sliders',
    mount,
    unmount() { host = null; },
    // 页面功能按钮统一放在底部功能区
    actions() {
      return [
        { id: 'save', label: '保存设置', icon: 'save', variant: 'filled', onClick: save },
        { id: 'openData', label: '打开数据目录', icon: 'folderOpen', variant: 'text', onClick: () => API.openDataDir().catch(() => toast('打开失败', { type: 'error' })) },
        { id: 'trashLog', label: '回收站日志', icon: 'history', variant: 'text', onClick: () => Shell.showTrashLog() },
        { id: 'reset', label: '恢复默认值', icon: 'refresh', variant: 'text', onClick: resetDefaults },
        { id: 'reload', label: '重新载入', icon: 'refresh', variant: 'text', onClick: () => mount(host) },
      ];
    },
    refresh() { if (host) mount(host); },
    status() {
      const e = S.env || {};
      return ICO('database', 14) + '<span class="ab-text">数据目录：' + esc(e.dataDir || '—') + '</span>';
    },
  };

  function resetDefaults() {
    UI.confirmDialog({
      title: '恢复默认设置',
      icon: 'history',
      html: '将把并发数、每页条数恢复为初始状态（不影响已存档的列表）。',
      confirmLabel: '恢复',
    }).then((ok) => {
      if (!ok) return;
      const prev = State.config || {};
      const c = Object.assign({}, prev, {
        theme: 'dark', concurrency: 0, pageSize: 100,
        minSize: 0, exclude: [], skipHidden: true, recursive: true, incremental: true,
        lastScanDir: prev.lastScanDir || '', lastCheckIn: prev.lastCheckIn || [],
      });
      API.setConfig(c).then(() => {
        State.config = c;
        S.cfg = c;
        Shell.applyConfig();
        mount(host);
        toast('已恢复默认设置');
      }).catch(() => {});
    });
  }
})();
