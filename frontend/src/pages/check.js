/* ============================================================
   页面：文件查重
   ============================================================ */
(function () {
  const { esc, num, bytes, duration, toast, dialog, confirmTrash } = UI;
  const { statGrid, bindPager, pathCell, searchBox, bindSearch, selectHtml, bindSelects, selValue } = W;

  // targets 元素：{ path, dir }，dir=false 表示单个文件
  const S = {
    listIds: [], targets: [],
    running: false, job: null, result: null, prog: null,
    filter: 'dup', query: '', page: 0, sort: 'path', desc: false,
    selection: new Set(),
  };

  let host = null;
  let lastAt = 0;

  /* ---------------------------------------------- 结构 */

  function shellHtml() {
    return '' +
      '<div class="card">' +
        '<div class="row gap-24 row--wrap" style="align-items:flex-start">' +
          '<div style="flex:1 1 320px;min-width:260px">' +
            '<div class="row gap-8">' + ICO('layers', 18) + '<span class="section-label">基准列表</span></div>' +
            '<div class="select-trigger mt-8" id="chkLists" tabindex="0">' +
              '<span class="ph">未选择</span><span class="caret">' + ICO('chevDown', 20) + '</span>' +
            '</div>' +
          '</div>' +
          '<div style="flex:2 1 440px;min-width:280px">' +
            '<div class="row gap-8">' + ICO('folder', 18) +
              '<span class="section-label">待查对象</span>' +
              '<span class="spacer"></span>' +
              '<span class="t-body-sm muted">' + ICO('drop', 14) + ' 拖入文件或文件夹即可加入</span>' +
            '</div>' +
            '<div class="row row--wrap gap-6 mt-8" id="chkTargets" style="min-height:34px"></div>' +
            '<div class="row gap-8 mt-12">' +
              '<div class="field grow">' +
                '<input id="chkAdd" placeholder=" " value="" style="padding-right:66px">' +
                '<label>添加目录或文件（回车确认）</label>' +
                '<div class="field-suffix">' +
                  '<button class="icon-btn icon-btn--sm" id="btnChkPick" title="选择目录">' + ICO('folder', 18) + '</button>' +
                  '<button class="icon-btn icon-btn--sm" id="btnChkPickFile" title="选择文件">' + ICO('file', 18) + '</button>' +
                '</div>' +
              '</div>' +
              '<button class="btn btn--text" id="btnChkClearTargets" style="flex:0 0 auto" title="清空已添加的目录与文件">' +
                ICO('close', 16) + '清空</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="card hidden" id="chkProgCard">' +
        '<div class="row gap-12">' +
          '<span class="spinner"></span><span class="t-title-sm" id="chkPhase">查重中</span>' +
          '<span class="spacer"></span><span class="t-body-sm muted" id="chkProgMeta"></span>' +
        '</div>' +
        '<div class="progress mt-12"><i id="chkProgBar" style="width:0"></i></div>' +
      '</div>' +

      '<div id="chkResult"></div>';
  }

  /* ---------------------------------------------- 基准列表多选 */

  function renderListsTrigger() {
    const el = UI.$('#chkLists', host);
    const chosen = State.lists.filter((l) => S.listIds.indexOf(l.id) >= 0);
    if (!chosen.length) {
      el.innerHTML = '<span class="ph">未选择</span><span class="caret">' + ICO('chevDown', 20) + '</span>';
    } else {
      el.innerHTML = chosen.map((l) =>
        '<span class="chip chip--sm selected">' + ICO('layers', 14) + esc(l.name) +
        '<span class="tag" style="height:18px;padding:0 6px">' + num(l.count) + '</span></span>').join('') +
        '<span class="caret">' + ICO('chevDown', 20) + '</span>';
    }
    el.classList.toggle('open', false);
    Shell.refreshActions();
  }

  function openListMenu() {
    const el = UI.$('#chkLists', host);
    if (!State.lists.length) {
      toast('还没有任何 MD5 列表，请先在「目录扫描」中生成', { duration: 4200 });
      return;
    }
    el.classList.add('open');
    const items = [
      { header: '选择基准列表' },
      { label: '全选', icon: 'check', onSelect: () => { S.listIds = State.lists.map((l) => l.id); refresh(); } },
      { label: '清空', icon: 'close', onSelect: () => { S.listIds = []; refresh(); } },
      { divider: true },
    ].concat(State.lists.map((l) => ({
      key: l.id,
      label: l.name,
      icon: S.listIds.indexOf(l.id) >= 0 ? 'check' : 'layers',
      hint: num(l.count),
      onSelect: (row) => {
        const i = S.listIds.indexOf(l.id);
        if (i >= 0) S.listIds.splice(i, 1); else S.listIds.push(l.id);
        const ic = row.querySelector('.ico');
        if (ic) ic.outerHTML = ICO(S.listIds.indexOf(l.id) >= 0 ? 'check' : 'layers', 20);
        renderListsTrigger();
        UI.$('#chkLists', host).classList.add('open');
      },
    })));

    function refresh() {
      UI.closeMenus();
      renderListsTrigger();
      openListMenu();
    }

    UI.showMenu(el, items, {
      sticky: true,
    });
    // 菜单关闭后取消高亮
    setTimeout(() => {
      const scrim = UI.$('.menu-scrim');
      if (scrim) scrim.addEventListener('mousedown', () => el.classList.remove('open'));
    }, 0);
  }

  /* ---------------------------------------------- 待查对象 */

  function normTarget(p) {
    return String(p || '').trim().replace(/[\\/]+$/, '').toLowerCase();
  }

  function hasTarget(p) {
    const k = normTarget(p);
    return !!k && S.targets.some((x) => normTarget(x.path) === k);
  }

  function renderTargets() {
    const el = UI.$('#chkTargets', host);
    if (!el) return;
    const clr = UI.$('#btnChkClearTargets', host);
    if (clr) clr.disabled = !S.targets.length;
    if (!S.targets.length) {
      el.innerHTML = '<span class="t-body-sm muted">未添加 — 拖入文件或文件夹，或用下方输入框 / 按钮添加</span>';
      Shell.refreshActions();
      return;
    }
    el.innerHTML = S.targets.map((t, i) =>
      '<span class="chip chip--input">' + ICO(t.dir ? 'folder' : 'file', 16) +
      '<span class="truncate" style="max-width:260px" title="' + esc(t.path) + '">' + esc(t.path) + '</span>' +
      '<button class="icon-btn icon-btn--sm" data-rm="' + i + '" title="移除">' + ICO('close', 16) + '</button></span>').join('');
    UI.$$('[data-rm]', el).forEach((b) => {
      b.onclick = () => { S.targets.splice(Number(b.dataset.rm), 1); renderTargets(); };
    });
    Shell.refreshActions();
  }

  /* ---------------------------------------------- 进度 */

  function showProgress(on) {
    UI.$('#chkProgCard', host).classList.toggle('hidden', !on);
    S.running = on;
    Shell.refreshActions();
  }

  function updateProgress(p) {
    const now = Date.now();
    if (now - lastAt < 100 && p.phase !== 'done') return;
    lastAt = now;
    S.prog = p;
    const total = p.total || 0, done = p.done || 0;
    const pct = p.phase === 'walking' ? 4 : total > 0 ? Math.min(100, (done / total) * 100) : 0;
    const bar = UI.$('#chkProgBar', host);
    if (bar) bar.style.width = pct.toFixed(1) + '%';
    const ph = UI.$('#chkPhase', host);
    if (ph) ph.textContent = p.phase === 'walking' ? '枚举文件' : '计算 MD5';
    const meta = UI.$('#chkProgMeta', host);
    if (meta) {
      const sp = p.elapsedMs > 0 ? p.bytes / (p.elapsedMs / 1000) : 0;
      meta.textContent = num(done) + (total ? ' / ' + num(total) : '') + '  ·  ' +
        bytes(p.bytes) + '  ·  ' + duration(p.elapsedMs) + (sp > 0 ? '  ·  ' + bytes(sp) + '/s' : '');
    }
  }

  /* ---------------------------------------------- 结果 */

  function renderResult() {
    const box = UI.$('#chkResult', host);
    const r = S.result;
    if (!r) { box.innerHTML = ''; return; }
    if (!r.ok) {
      box.innerHTML = '<div class="card"><div class="row gap-12">' + ICO('alert', 22) +
        '<span>' + esc(r.error || '查重失败') + '</span></div></div>';
      return;
    }
    box.innerHTML = '' +
      '<div class="card card--flush">' +
        '<div class="card-head">' + ICO('target', 20) + '<h3>查重结果</h3>' +
          '<span class="spacer"></span>' +
          '<button class="btn btn--text btn--sm" id="btnArchive" style="flex:0 0 auto" title="把查重结果新建为列表或叠加到已有列表">' +
            ICO('save', 16) + '存档为列表</button>' +
          '<span class="t-body-sm muted truncate" style="max-width:320px">' +
            esc((r.lists || []).join(' + ')) + '</span>' +
        '</div>' +
        '<div class="card-body">' +
          statGrid([
            { label: '待查文件', value: num(r.total) },
            { label: '命中重复', value: num(r.matched), tone: r.matched ? 'error' : '' },
            { label: '未命中', value: num(r.unique), tone: 'primary' },
            { label: '可释放空间', value: bytes(r.matchSize), tone: r.matchSize ? 'tertiary' : '' },
            { label: '错误', value: num(r.errors) },
            { label: '耗时', value: duration(r.elapsedMs) },
          ]) +
        '</div>' +
        '<div class="card-body" style="padding-bottom:0">' +
          '<div class="row gap-8 row--wrap">' +
            '<div class="segmented">' +
              '<button data-f="dup" class="' + (S.filter === 'dup' ? 'selected' : '') + '">仅重复</button>' +
              '<button data-f="all" class="' + (S.filter === 'all' ? 'selected' : '') + '">全部</button>' +
              '<button data-f="unique" class="' + (S.filter === 'unique' ? 'selected' : '') + '">未命中</button>' +
            '</div>' +
            '<span class="spacer"></span>' + searchBox('搜索路径或 MD5', S.query) +
          '</div>' +
        '</div>' +
        '<div id="chkTable" class="table-wrap" style="max-height:50vh"></div>' +
        '<div class="row gap-8" style="padding:12px 16px;border-top:1px solid var(--md-outline-variant);flex-wrap:wrap">' +
          '<span class="t-body-sm muted" id="chkSelInfo"></span>' +
          '<span class="spacer"></span>' +
          '<button class="btn btn--text btn--sm" id="btnSelAll">' + ICO('check', 18) + '全选命中</button>' +
          '<button class="btn btn--text btn--sm" id="btnSelNone">' + ICO('close', 18) + '清空选择</button>' +
          '<button class="btn btn--danger" id="btnTrash">' + ICO('trash', 18) + '移入回收站</button>' +
        '</div>' +
        '<div id="chkPager"></div>' +
      '</div>';

    UI.$$('[data-f]', box).forEach((b) => {
      b.onclick = () => { S.filter = b.dataset.f; S.page = 0; renderResult(); };
    });
    bindSearch(box, (v) => { S.query = v; S.page = 0; loadTable(); });
    UI.$('#btnArchive', box).onclick = archiveDialog;
    UI.$('#btnSelAll', box).onclick = selectAllMatched;
    UI.$('#btnSelNone', box).onclick = () => { S.selection.clear(); updateSelInfo(); loadTable(); };
    UI.$('#btnTrash', box).onclick = doTrash;
    loadTable();
    updateSelInfo();
  }

  function loadTable() {
    if (!S.result || !S.result.jobId) return;
    const box = UI.$('#chkTable', host);
    API.checkPage({
      key: S.result.jobId, offset: S.page, limit: 200,
      query: S.query, filter: S.filter, sort: S.sort, desc: S.desc,
    }).then((pg) => {
      if (!pg.total) {
        box.innerHTML = UI.emptyState('search', S.filter === 'dup' ? '没有命中重复文件' : '没有匹配的文件');
      } else {
        box.innerHTML =
          '<table class="tbl"><thead><tr>' +
          '<th class="col-check"><label class="check"><input type="checkbox" id="chkAll"><span class="box">' + ICO('check', 14) + '</span></label></th>' +
          '<th class="sortable" data-sort="path">路径</th>' +
          '<th class="sortable col-num" data-sort="size">大小</th>' +
          '<th>MD5</th><th>命中</th><th class="cell-actions"></th>' +
          '</tr></thead><tbody>' +
          pg.items.map((it) => {
            const on = S.selection.has(it.path);
            return '<tr' + (on ? ' class="selected"' : '') + ' data-path="' + esc(it.path) + '">' +
              '<td class="col-check"><label class="check"><input type="checkbox"' + (on ? ' checked' : '') +
              ' data-sel="' + esc(it.path) + '"><span class="box">' + ICO('check', 14) + '</span></label></td>' +
              '<td>' + pathCell(it.path, it.matched ? '<span class="tag tag--error">重复</span>' : '') + '</td>' +
              '<td class="col-num">' + bytes(it.size) + '</td>' +
              '<td class="mono md5' + (it.matched ? ' match' : '') + '">' + esc(it.md5 || '—') + '</td>' +
              '<td>' + (it.matched
                ? '<span class="tag tag--primary" title="' + esc(it.matchPath) + '">' + esc(it.matchList || '') + '</span>'
                : '<span class="tag">—</span>') + '</td>' +
              '<td class="cell-actions">' +
                '<button class="icon-btn icon-btn--sm" data-reveal="' + esc(it.path) + '" title="定位">' + ICO('external', 18) + '</button>' +
              '</td></tr>';
          }).join('') +
          '</tbody></table>';
      }
      bindTable();
      bindPager(UI.$('#chkPager', host), pg, (o) => { S.page = o; loadTable(); });
    }).catch(() => {});
  }

  function bindTable() {
    const box = UI.$('#chkTable', host);
    UI.$$('tr[data-path]', box).forEach((tr) => {
      const cb = UI.$('input[data-sel]', tr);
      tr.onclick = (e) => {
        if (e.target.closest('button')) return;
        cb.checked = !cb.checked;
        toggleSel(tr.dataset.path, cb.checked, tr);
      };
      cb.onclick = (e) => {
        e.stopPropagation();
        toggleSel(tr.dataset.path, cb.checked, tr);
      };
    });
    UI.$$('[data-reveal]', box).forEach((b) => { b.onclick = (e) => { e.stopPropagation(); API.reveal(b.dataset.reveal); }; });
    UI.$$('th[data-sort]', box).forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.sort;
        if (S.sort === k) S.desc = !S.desc; else { S.sort = k; S.desc = false; }
        S.page = 0; loadTable();
      };
    });
    const all = UI.$('#chkAll', box);
    if (all) {
      const paths = UI.$$('tr[data-path]', box).map((t) => t.dataset.path);
      const sel = paths.filter((p) => S.selection.has(p)).length;
      all.checked = paths.length > 0 && sel === paths.length;
      all.indeterminate = sel > 0 && sel < paths.length;
      all.onclick = (e) => {
        e.stopPropagation();
        const on = all.checked;
        paths.forEach((p) => { if (on) S.selection.add(p); else S.selection.delete(p); });
        loadTable(); updateSelInfo();
      };
    }
  }

  function toggleSel(path, on, tr) {
    if (on) S.selection.add(path); else S.selection.delete(path);
    if (tr) tr.classList.toggle('selected', on);
    updateSelInfo();
  }

  function updateSelInfo() {
    const el = UI.$('#chkSelInfo', host);
    if (!el) return;
    el.textContent = S.selection.size ? '已选 ' + num(S.selection.size) + ' 项' : '未选择文件';
    const btn = UI.$('#btnTrash', host);
    if (btn) btn.disabled = S.selection.size === 0;
  }

  function selectAllMatched() {
    if (!S.result) return;
    API.checkAllMatched(S.result.jobId).then((paths) => {
      paths.forEach((p) => S.selection.add(p));
      loadTable();
      updateSelInfo();
      toast('已选中 ' + num(paths.length) + ' 个命中文件');
    }).catch(() => {});
  }

  function doTrash() {
    const paths = Array.from(S.selection);
    if (!paths.length) { toast('请先选择文件', { type: 'error' }); return; }
    confirmTrash(paths.length, bytes(S.result.matchSize)).then((ok) => {
      if (!ok) return;
      API.moveToTrash({ paths, jobId: S.result.jobId }).then((r) => {
        if (r.moved > 0) toast('已移入回收站 ' + num(r.moved) + ' 个文件 · 释放 ' + bytes(r.freed));
        if (r.failed > 0) {
          dialog({
            title: '部分文件未能移入回收站',
            icon: 'alert',
            body: '<p>失败 ' + num(r.failed) + ' 个：</p><div class="dialog-list">' +
              r.errors.map((e) => '<div class="row t-body-sm">' + esc(e) + '</div>').join('') + '</div>',
            actions: [{ label: '知道了', variant: 'filled' }],
          });
        }
        S.selection.clear();
        S.result.matched = Math.max(0, S.result.matched - r.moved);
        S.result.total = Math.max(0, S.result.total - r.moved);
        renderResult();
      }).catch(() => {});
    });
  }

  /* ---------------------------------------------- 存档为列表 */

  // 查重结束后可把结果新建为列表，或叠加到已有列表
  function archiveDialog() {
    const r = S.result;
    if (!r || !r.jobId) { toast('没有可存档的查重结果', { type: 'error' }); return; }
    const opts = State.lists.map((l) => [l.id, l.name + '（' + num(l.count) + ' 条）']);
    dialog({
      title: '存档查重结果',
      icon: 'save',
      body: '<p class="t-body-sm muted">本次查重 ' + num(r.total) + ' 个文件，命中 ' + num(r.matched) +
        ' 个。按 MD5 归并后写入列表，重复 MD5 会自动合并。</p>' +
        '<div class="dialog-fields">' +
        selectHtml({ id: 'arMode', label: '方式', value: 'new', options: [['new', '新建列表'], ['merge', '叠加到已有列表']] }) +
        '<div id="arMergeWrap" class="hidden">' +
          (opts.length
            ? selectHtml({ id: 'arTarget', label: '目标列表', options: opts })
            : '<div class="t-body-sm muted" style="padding:6px 2px">还没有任何列表，请先新建</div>') +
        '</div>' +
        '<div class="field"><input id="arName" placeholder=" " value=""><label>列表名 / 层名称</label></div>' +
        '<div class="field"><input id="arNote" placeholder=" " value=""><label>备注</label></div>' +
        selectHtml({ id: 'arScope', label: '存档内容', value: 'matched', options: [['matched', '仅命中的重复文件'], ['all', '全部待查文件']] }) +
        '</div>',
      onMount: (box) => {
        bindSelects(box, (id, v) => {
          if (id === 'arMode') UI.$('#arMergeWrap', box).classList.toggle('hidden', v !== 'merge');
        });
      },
      actions: [
        { label: '取消', variant: 'text' },
        {
          label: '存档', variant: 'filled', keepOpen: true,
          onClick: (api, box) => {
            const mode = selValue(box, 'arMode');
            const targetId = mode === 'merge' ? selValue(box, 'arTarget') : '';
            if (mode === 'merge' && !targetId) { toast('请选择要叠加的目标列表', { type: 'error' }); return false; }
            const req = {
              jobId: r.jobId,
              targetId,
              saveAs: UI.$('#arName', box).value.trim(),
              note: UI.$('#arNote', box).value.trim(),
              onlyMatched: selValue(box, 'arScope') === 'matched',
            };
            API.archiveCheck(req).then((res) => {
              api.close();
              toast(res.message || '已存档', {
                duration: 8000,
                actionLabel: res.listId ? '查看' : '',
                onAction: () => Shell.go('lists', res.listId),
              });
              Shell.reloadLists();
            }).catch((e) => toast('存档失败：' + (e && e.message ? e.message : e), { type: 'error' }));
            return false;
          },
        },
      ],
    });
  }

  /* ---------------------------------------------- 交互 */

  function bindForm() {
    UI.$('#chkLists', host).onclick = openListMenu;
    UI.$('#btnChkPick', host).onclick = () => addDir();
    UI.$('#btnChkPickFile', host).onclick = () => addFiles();
    UI.$('#btnChkClearTargets', host).onclick = () => clearTargets();
    const addInp = UI.$('#chkAdd', host);
    addInp.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const v = addInp.value.trim();
      if (!v) return;
      addTypedPath(v);
      addInp.value = '';
    };
  }

  function addDir() {
    API.pickDir('选择待查目录', '').then((p) => { if (p) addTargets([{ path: p, dir: true }]); }).catch(() => {});
  }

  function addFiles() {
    API.pickFiles('选择待查文件').then((ps) => {
      if (ps && ps.length) addTargets(ps.map((p) => ({ path: p, dir: false })));
    }).catch(() => {});
  }

  // 输入框手填的路径：交给后端判定是目录还是文件
  function addTypedPath(p) {
    p = String(p || '').trim();
    if (!p) return;
    API.inspectPaths([p]).then((ks) => {
      const k = (ks || [])[0];
      if (!addTargets([{ path: p, dir: k ? !!k.dir : true }])) toast('该路径已在待查对象中');
    }).catch(() => {
      if (!addTargets([{ path: p, dir: true }])) toast('该路径已在待查对象中');
    });
  }

  function clearTargets() {
    S.targets = [];
    renderTargets();
  }

  // 追加待查对象（自动去重），返回真正新增的个数
  function addTargets(list) {
    let added = 0;
    (list || []).forEach((it) => {
      const obj = (it && typeof it === 'object');
      const p = String(obj ? (it.path || '') : (it || '')).trim();
      if (!p || hasTarget(p)) return;
      S.targets.push({ path: p, dir: obj ? !!it.dir : true });
      added++;
    });
    if (added) renderTargets();
    return added;
  }

  // 「重置」：清空待查对象与查重结果，回到初始状态
  function resetAll() {
    S.targets = [];
    S.result = null; S.job = null; S.selection.clear();
    S.page = 0; S.query = ''; S.filter = 'dup';
    UI.$('#chkResult', host).innerHTML = '';
    UI.$('#chkAdd', host).value = '';
    renderTargets();
    Shell.refreshActions();
  }

  function start() {
    if (S.running) return;
    if (!S.listIds.length) { toast('请选择基准列表', { type: 'error' }); return; }
    if (!S.targets.length) { toast('请添加待查对象（目录或文件）', { type: 'error' }); return; }
    S.result = null; S.selection.clear(); S.page = 0; S.query = '';
    UI.$('#chkResult', host).innerHTML = '';
    // 查重参数使用内置默认值（递归子目录、跳过隐藏、不限制大小、不排除）
    API.startCheck({
      listIds: S.listIds, targets: S.targets.map((t) => t.path),
      recursive: true, minSize: 0, exclude: [], skipHidden: true,
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

  // 拖入的文件 / 目录都直接作为待查对象（单个文件也支持）
  function onDrop(paths) {
    if (!paths || !paths.length) return;
    API.inspectPaths(paths).then((ks) => {
      const items = [];
      (ks || []).forEach((k) => {
        if (k.error) return;
        items.push({ path: k.path, dir: !!k.dir });
      });
      if (!items.length) { toast('未识别到可查重的路径', { type: 'error' }); return; }
      const added = addTargets(items);
      if (!added) { toast('这些路径已在待查对象中'); return; }
      const nf = items.filter((x) => !x.dir).length;
      toast('已加入 ' + num(added) + ' 项待查对象' + (nf ? '（含 ' + num(nf) + ' 个文件）' : '') +
        (added < items.length ? '，其余重复已忽略' : ''));
    }).catch(() => {});
  }

  /* ---------------------------------------------- 生命周期 */

  function mount(root) {
    host = root;
    host.innerHTML = shellHtml();
    bindForm();
    renderListsTrigger();
    renderTargets();
    if (S.result) renderResult();
    if (S.running) showProgress(true);
  }

  function onProgress(p) {
    if (!S.running || (S.job && p.jobId !== S.job)) return;
    updateProgress(p);
  }

  function onDone(d) {
    if (d.kind !== 'check' || (S.job && d.jobId !== S.job)) return;
    S.job = null;
    showProgress(false);
    if (!d.ok && d.error) { toast(d.error, { type: 'error' }); return; }
    S.result = d.check;
    S.filter = 'dup'; S.page = 0; S.query = '';
    renderResult();
    Shell.refreshActions();
    if (d.check && d.check.matched > 0) {
      toast('命中 ' + num(d.check.matched) + ' 个重复文件，可释放 ' + bytes(d.check.matchSize));
    } else {
      toast('未发现重复文件');
    }
  }

  window.Pages = window.Pages || {};
  window.Pages.check = {
    id: 'check', title: '文件查重', subtitle: '用已存档的 MD5 列表比对文件', icon: 'target',
    mount,
    unmount() { host = null; },
    onProgress,
    onDone,
    onDrop,
    dropHint() { return '松开即把这些文件 / 文件夹加入待查对象'; },
    isRunning() { return S.running; },
    // 页面功能按钮统一放在底部功能区
    actions() {
      const a = [
        {
          id: 'reset', label: '重置', icon: 'refresh', variant: 'text',
          title: '清空待查对象与查重结果',
          disabled: S.running || (!S.targets.length && !S.result), onClick: resetAll,
        },
        { id: 'clearT', label: '清空待查', icon: 'close', variant: 'text', disabled: !S.targets.length, onClick: clearTargets },
      ];
      a.push(S.running
        ? { id: 'cancel', label: '取消查重', icon: 'stop', variant: 'outlined', onClick: cancel }
        : { id: 'start', label: '开始查重', icon: 'search', variant: 'filled', onClick: start });
      return a;
    },
    reset() { S.result = null; S.job = null; S.running = false; S.selection.clear(); },
    status() {
      if (S.running) return '<span class="spinner spinner--sm"></span><span class="ab-text">查重进行中…</span>';
      const r = S.result;
      if (r && r.ok) {
        return ICO('target', 14) + '<span class="ab-text">上次查重：命中 ' + num(r.matched) + ' / ' + num(r.total) +
          ' · 可释放 ' + bytes(r.matchSize) + '</span>';
      }
      if (!S.targets.length) {
        return ICO('folder', 14) + '<span class="ab-text">请添加待查对象（可拖入多个文件夹或文件）</span>';
      }
      const nf = S.targets.filter((x) => !x.dir).length;
      return ICO('layers', 14) + '<span class="ab-text">基准列表 ' + num(S.listIds.length) +
        ' 个 · 待查对象 ' + num(S.targets.length) + ' 项' + (nf ? '（含 ' + num(nf) + ' 个文件）' : '') + '</span>';
    },
  };
})();
