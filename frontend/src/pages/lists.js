/* ============================================================
   页面：MD5 列表管理
   ============================================================ */
(function () {
  const { esc, num, bytes, fmtTime, relTime, toast, dialog, confirmDialog } = UI;
  const { pagerHtml, bindPager, pathCell, searchBox, bindSearch, selectHtml, bindSelects, selValue } = W;

  const S = {
    activeId: null,
    filter: '', page: 0, query: '', layer: '', sort: 'md5', desc: false,
    meta: null, pageData: null, dirty: false,
    selection: new Set(), lastSelIndex: -1,
  };

  let host = null;

  /* ---------------------------------------------- 结构 */

  function shellHtml() {
    // 左栏：搜索框直接顶到最上面，不再有「列表 N 个」标题栏
    return '<div class="split">' +
      '<div class="card card--flush">' +
        '<div style="padding:8px 10px 6px">' + searchBox('搜索列表', S.filter) + '</div>' +
        '<div id="listItems"></div>' +
      '</div>' +
      '<div id="listDetail"></div>' +
    '</div>';
  }

  function renderListItems() {
    const el = UI.$('#listItems', host);
    if (!el) return;
    // activeId 指向的列表可能刚被删除（例如删的是另一项、或多选里不含它），
    // 不清理会残留 active 高亮，详情面板也会停在已失效的内容上
    if (S.activeId && !State.lists.some((l) => l.id === S.activeId)) {
      S.activeId = null;
      S.meta = null;
    }
    // innerHTML 重写会把滚动位置弹回顶部，重绘前后手动保住它
    const keepScroll = el.scrollTop;
    const q = S.filter.toLowerCase();
    const items = State.lists.filter((l) =>
      !q || l.name.toLowerCase().includes(q) || (l.note || '').toLowerCase().includes(q));
    if (!items.length) {
      el.innerHTML = UI.emptyState('layers', State.lists.length ? '无匹配列表' : '还没有列表',
        State.lists.length ? '' : '在「目录扫描」中生成，或在「文件查重」后存档结果');
      Shell.refreshActions();
      return;
    }
    el.innerHTML = items.map((l, idx) =>
      '<div class="list-item' + (l.id === S.activeId ? ' active' : '') + (S.selection.has(l.id) ? ' selected' : '') + '" data-id="' + esc(l.id) + '" data-idx="' + idx + '">' +
        ICO('layers', 18) +
        '<div class="grow" style="min-width:0">' +
          '<div class="li-title truncate">' + esc(l.name) + '</div>' +
          '<div class="li-sub muted truncate">' + num(l.count) + ' 条 · ' + bytes(l.totalSize) + ' · ' + relTime(l.updatedAt) + '</div>' +
          (l.note ? '<div class="li-sub muted truncate" title="' + esc(l.note) + '">' + esc(l.note) + '</div>' : '') +
        '</div></div>').join('');
    UI.$$('.list-item', el).forEach((it) => {
      it.onclick = (e) => onItemClick(e, it);
      it.oncontextmenu = (e) => {
        e.preventDefault();
        const id = it.dataset.id;
        // 右键目标不在选区中时改为单选它；只重绘一次（clear+toggle 会重绘两遍）
        // 注意：重绘后 it 已脱离文档，再用它做锚点会测得全 0 矩形
        if (!S.selection.has(id)) {
          S.selection.clear();
          S.selection.add(id);
          S.lastSelIndex = Number(it.dataset.idx);
          renderListItems();
          Shell.refreshActions();
        }
        // 锚点用指针坐标，菜单稳定出现在光标处
        // 键盘菜单键触发时 clientX/clientY 可能为 0，此时退回元素（UI 内部再兜底到指针位置）
        // 锚点用指针坐标，菜单稳定出现在光标处
        // 键盘菜单键触发时 clientX/clientY 可能为 0，此时退回元素（UI 内部再兜底到指针位置）
        const pt = (e.clientX || e.clientY) ? { x: e.clientX, y: e.clientY } : null;
        UI.showMenu(pt || it, listContextMenu());
      };
    });
    if (keepScroll) el.scrollTop = keepScroll;
    Shell.refreshActions();
  }

  // 列表项右键：无 header，支持多选叠加
  function listContextMenu() {
    const sel = Array.from(S.selection);
    const single = sel.length === 1 ? sel[0] : '';
    const items = [
      { label: '复制', icon: 'copy', disabled: !single, onSelect: () => single && copyAs(single) },
    ];
    if (sel.length >= 2) {
      items.push({ label: '叠加选中列表', icon: 'merge', onSelect: () => mergeSelected() });
    }
    items.push({ divider: true });
    items.push({ label: '删除', icon: 'trash', danger: true, onSelect: () => removeSelected() });
    return items;
  }

  /* ---------------------------------------------- 详情 */

  function revealListFile(id) {
    const dir = State.env && State.env.dataDir ? State.env.dataDir : '';
    if (!dir) { toast('数据目录未知', { type: 'error' }); return; }
    API.reveal(dir + '\\lists\\' + id + '.json').catch(() => toast('定位失败', { type: 'error' }));
  }

  function renderDetail() {
    const box = UI.$('#listDetail', host);
    if (!box) return;
    const l = S.meta;
    if (!l) {
      box.innerHTML = '<div class="card">' + UI.emptyState('layers', '选择一个列表', '左侧列表中点击查看详情') + '</div>';
      Shell.refreshActions();
      return;
    }
    const layers = l.layers || [];
    box.innerHTML = '' +
      '<div class="card">' +
        // 名称 / 备注 / 保存 / 定位：不换行，输入框自适应收缩，按钮永不被挤出
        '<div class="row gap-12" style="align-items:flex-start">' +
          '<div class="field" style="flex:1 1 180px;min-width:110px">' +
            '<input id="listName" placeholder=" " value="' + esc(l.name) + '"><label>名称</label></div>' +
          '<div class="field" style="flex:2 1 200px;min-width:130px">' +
            '<input id="listNote" placeholder=" " value="' + esc(l.note || '') + '"><label>备注</label></div>' +
          '<button class="btn btn--filled" id="btnSaveMeta" style="flex:0 0 auto">' + ICO('save', 16) + '保存</button>' +
          '<button class="btn btn--text" id="btnRevealFile" style="flex:0 0 auto" title="在资源管理器中定位列表文件">' +
            ICO('external', 16) + '定位</button>' +
        '</div>' +
        '<div class="row row--wrap gap-8 mt-12">' +
          '<span class="tag">' + ICO('hash', 14) + num(l.count) + ' 条</span>' +
          '<span class="tag">' + ICO('disk', 14) + bytes(l.totalSize) + '</span>' +
          '<span class="tag">' + ICO('clock', 14) + '更新 ' + esc(fmtTime(l.updatedAt)) + '</span>' +
        '</div>' +
      '</div>' +

      '<div class="card card--flush card--fill">' +
        '<div class="card-head">' + ICO('table', 20) + '<h3>条目</h3><span class="spacer"></span>' +
          searchBox('搜索 MD5 或文件名', S.query) +
        '</div>' +
        '<div id="listTable" class="table-wrap"></div>' +
        '<div id="listPager"></div>' +
      '</div>';

    UI.$('#btnSaveMeta', box).onclick = saveMeta;
    UI.$('#btnRevealFile', box).onclick = () => revealListFile(l.id);
    const nameInp = UI.$('#listName', box);
    const noteInp = UI.$('#listNote', box);
    const onEdit = () => { S.dirty = nameInp.value !== l.name || noteInp.value !== (l.note || ''); };
    nameInp.oninput = onEdit; noteInp.oninput = onEdit;
    nameInp.onkeydown = (e) => { if (e.key === 'Enter') saveMeta(); };

    bindSearch(box, (v) => { S.query = v; S.page = 0; loadTable(); });
    loadTable();
  }

  function loadTable() {
    if (!S.activeId) return;
    const box = UI.$('#listTable', host);
    if (!box) return;
    API.listPage({
      key: S.activeId, offset: S.page, limit: 200, query: S.query,
      sort: S.sort, desc: S.desc,
    }).then((pg) => {
      S.pageData = pg;
      if (!pg.total) {
        box.innerHTML = UI.emptyState('hash', '没有条目', '该列表为空，或没有匹配项');
      } else {
        box.innerHTML =
          '<table class="tbl"><thead><tr>' +
          '<th class="sortable" data-sort="md5">MD5</th>' +
          '<th class="sortable col-num" data-sort="size">大小</th>' +
          '<th>文件名</th>' +
          '</tr></thead><tbody>' +
          pg.items.map((e) => {
            const names = (e.paths || []).map((p) => UI.splitPath(p.path).name);
            const shown = names.slice(0, 2);
            const more = names.length - shown.length;
            return '<tr data-md5="' + esc(e.md5) + '">' +
              '<td class="mono md5">' + esc(e.md5) + '</td>' +
              '<td class="col-num">' + bytes(e.size) + '</td>' +
              '<td>' + (shown.length
                ? '<span class="truncate" title="' + esc(names.join(' / ')) + '">' +
                  esc(shown.join(' · ')) +
                  (more > 0 ? ' <span class="tag tag--primary">+' + num(more) + '</span>' : '') +
                  '</span>'
                : '—') + '</td>' +
              '</tr>';
          }).join('') + '</tbody></table>';
      }
      UI.$$('th[data-sort]', box).forEach((th) => {
        th.onclick = () => {
          const k = th.dataset.sort;
          if (S.sort === k) S.desc = !S.desc; else { S.sort = k; S.desc = false; }
          S.page = 0; loadTable();
        };
      });
      UI.$$('tr[data-md5]', box).forEach((tr) => { tr.onclick = () => showEntry(tr.dataset.md5); });
      bindPager(UI.$('#listPager', host), pg, (o) => { S.page = o; loadTable(); });
    }).catch((e) => { box.innerHTML = UI.emptyState('alert', '读取失败', String(e.message || e)); });
  }

  function showEntry(md5) {
    const e = ((S.pageData && S.pageData.items) || []).find((x) => x.md5 === md5);
    if (!e) return;
    const names = (e.paths || []).map((p) => UI.splitPath(p.path).name);
    dialog({
      title: '条目详情',
      icon: 'hash',
      wide: true,
      body: '<p class="mono selectable">' + esc(e.md5) + '</p>' +
        '<p>大小 ' + bytes(e.size) +
        (e.note ? ' · ' + esc(e.note) : '') + '</p>' +
        '<div class="dialog-list">' + (e.paths || []).map((p) =>
          '<div class="row"><span class="grow truncate selectable" title="' + esc(p.path) + '">' + esc(UI.splitPath(p.path).name) + '</span>' +
          '<button class="icon-btn icon-btn--sm" data-reveal="' + esc(p.path) + '" title="定位">' + ICO('external', 18) + '</button>' +
          '<button class="icon-btn icon-btn--sm" data-copy2="' + esc(p.path) + '" title="复制">' + ICO('copy', 18) + '</button>' +
          '</div>').join('') + '</div>',
      actions: [{ label: '关闭', variant: 'text' }],
    });
    UI.$$('[data-reveal]').forEach((b) => {
      b.onclick = () => API.reveal(b.dataset.reveal).catch(() => toast('定位失败：文件不存在或不可访问', { type: 'error' }));
    });
    UI.$$('[data-copy2]').forEach((b) => { b.onclick = () => UI.copyText(b.dataset.copy2); });
  }

  /* ---------------------------------------------- 操作 */

  function select(id, keepSel) {
    if (!host) { S.activeId = id; return; }
    S.activeId = id; S.page = 0; S.query = ''; S.layer = '';
    if (!keepSel) clearSelection();
    renderListItems();
    Shell.refreshActions();
    API.listMeta(id).then((m) => { S.meta = m; renderDetail(); })
      .catch(() => { S.meta = null; renderDetail(); });
  }

  /* ---------------------------------------------- 多选 */

  function clearSelection() {
    S.selection.clear();
    S.lastSelIndex = -1;
    renderListItems();
    Shell.refreshActions();
  }

  function toggleSel(id, on) {
    if (on) S.selection.add(id); else S.selection.delete(id);
    renderListItems();
    Shell.refreshActions();
  }

  function onItemClick(e, it) {
    const id = it.dataset.id;
    const idx = Number(it.dataset.idx);
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleSel(id, !S.selection.has(id));
      S.lastSelIndex = idx;
      return;
    }
    if (e.shiftKey && S.lastSelIndex >= 0) {
      e.preventDefault();
      const start = Math.min(S.lastSelIndex, idx);
      const end = Math.max(S.lastSelIndex, idx);
      const visible = State.lists.filter((l) => {
        const q = S.filter.toLowerCase();
        return !q || l.name.toLowerCase().includes(q) || (l.note || '').toLowerCase().includes(q);
      });
      for (let i = start; i <= end; i++) {
        if (visible[i]) S.selection.add(visible[i].id);
      }
      S.lastSelIndex = idx;
      renderListItems();
      Shell.refreshActions();
      return;
    }
    // 普通单击：清空其他选择，仅选中当前项并打开详情
    if (S.selection.has(id) && S.selection.size === 1) {
      S.lastSelIndex = idx;
      return;
    }
    S.selection.clear();
    S.selection.add(id);
    S.lastSelIndex = idx;
    select(id, true);
  }

  function mergeSelected() {
    const sel = Array.from(S.selection);
    if (sel.length < 2) { toast('请至少选择两个列表进行叠加', { type: 'error' }); return; }
    // 以第一个为基准，其余叠加进去
    const targetId = sel[0];
    const others = sel.slice(1);
    const target = State.lists.find((l) => l.id === targetId);
    dialog({
      title: '叠加 ' + num(sel.length) + ' 个列表',
      icon: 'merge',
      body: '<p>以「' + esc(target ? target.name : '') + '」为基准，合并其余 ' + num(others.length) + ' 个列表。</p>' +
        '<div class="dialog-fields">' +
        '<div class="field"><input id="mgName" placeholder=" "><label>层名称</label></div>' +
        '<div class="field"><input id="mgNote" placeholder=" "><label>层备注</label></div>' +
        '</div>',
      actions: [
        { label: '取消', variant: 'text' },
        {
          label: '叠加', variant: 'filled', keepOpen: true,
          onClick: (api, box) => {
            const name = UI.$('#mgName', box).value.trim();
            const note = UI.$('#mgNote', box).value;
            // 串行叠加
            let chain = Promise.resolve();
            others.forEach((srcId) => {
              chain = chain.then(() => API.mergeLists({
                targetId, sourceId: srcId, layerName: name, note,
              }).then((r) => {
                toast(r.message || '已叠加');
              }));
            });
            chain.then(() => {
              api.close();
              clearSelection();
              Shell.reloadLists().then(() => {
                renderListItems();
                if (S.activeId === targetId) select(targetId);
              });
            }).catch(() => {});
            return false;
          },
        },
      ],
    });
  }

  function removeSelected() {
    const sel = Array.from(S.selection);
    if (!sel.length) return;
    confirmDialog({
      title: '删除列表',
      icon: 'trash',
      danger: true,
      html: '将删除 ' + num(sel.length) + ' 个列表。此操作不可撤销。',
      confirmLabel: '删除',
    }).then((ok) => {
      if (!ok) return;
      let chain = Promise.resolve();
      sel.forEach((id) => {
        chain = chain.then(() => API.deleteList(id).catch(() => {}));
      });
      chain.then(() => {
        toast('已删除 ' + num(sel.length) + ' 个列表');
        // 删掉的不是当前项时 activeId 仍在，但 S.meta 可能还没加载完（甚至没加载过），
        // 统一在删除完成后刷一次详情面板：没 meta 就补一次 listMeta
        clearSelection();
        return Shell.reloadLists();
      }).then(() => {
        renderListItems();
        return refreshDetail();
      }).catch(() => {});
    });
  }

  // 刷新右侧详情面板；当前项存在但 meta 缺失时补加载（删除 / 改名 / 切页都可能出现）
  function refreshDetail() {
    if (!S.activeId) { renderDetail(); return Promise.resolve(); }
    if (S.meta) { renderDetail(); return Promise.resolve(); }
    return API.listMeta(S.activeId)
      .then((m) => { S.meta = m; renderDetail(); })
      .catch(() => { S.meta = null; renderDetail(); });
  }

  function saveMeta() {
    if (!S.activeId) return;
    const name = UI.$('#listName', host).value.trim();
    const note = UI.$('#listNote', host).value;
    API.renameList(S.activeId, name, note).then(() => {
      toast('已保存');
      return Shell.reloadLists();
    }).then(() => {
      renderListItems();
      return API.listMeta(S.activeId);
    }).then((m) => { S.meta = m; S.dirty = false; renderDetail(); }).catch(() => {});
  }

  function copyAs(id) {
    const l = State.lists.find((x) => x.id === id);
    dialog({
      title: '另存为',
      icon: 'copy',
      body: '<div class="dialog-fields">' +
        '<div class="field"><input id="copyName" placeholder=" " value="' + esc((l ? l.name : '') + ' 副本') + '"><label>新列表名</label></div>' +
        '</div>',
      actions: [
        { label: '取消', variant: 'text' },
        {
          label: '另存', variant: 'filled', keepOpen: true,
          onClick: (api, box) => {
            const name = UI.$('#copyName', box).value.trim();
            API.copyList(id, name).then((r) => {
              api.close();
              toast(r.message || '已另存');
              Shell.reloadLists().then(() => { renderListItems(); if (r.listId) select(r.listId); });
            }).catch(() => {});
            return false;
          },
        },
      ],
    });
  }


  function exportDialog(id) {
    const l = State.lists.find((x) => x.id === id);
    dialog({
      title: '导出列表',
      icon: 'download',
      body: '<p>' + esc(l ? l.name : '') + '</p><div class="dialog-fields">' +
        selectHtml({
          id: 'exFmt', label: '格式',
          options: [['json', 'JSON（可再次导入）'], ['csv', 'CSV（Excel 可读）'], ['txt', '纯文本（MD5 + 路径）']],
        }) + '</div>',
      onMount: (box) => bindSelects(box),
      actions: [
        { label: '取消', variant: 'text' },
        {
          label: '导出', variant: 'filled', keepOpen: true,
          onClick: (api, box) => {
            const fmt = selValue(box, 'exFmt');
            API.exportList(id, fmt, '').then((p) => {
              api.close();
              toast('已导出到 ' + p, {
                actionLabel: '打开', duration: 8000,
                onAction: () => API.reveal(p),
              });
            }).catch(() => {});
            return false;
          },
        },
      ],
    });
  }

  function removeList(id) {
    const l = State.lists.find((x) => x.id === id);
    confirmDialog({
      title: '删除列表',
      icon: 'trash',
      danger: true,
      html: '将删除列表「<b>' + esc(l ? l.name : '') + '</b>」。此操作不可撤销。',
      confirmLabel: '删除',
    }).then((ok) => {
      if (!ok) return;
      API.deleteList(id).then(() => {
        toast('已删除');
        if (S.activeId === id) { S.activeId = null; S.meta = null; }
        return Shell.reloadLists();
      }).then(() => {
        renderListItems();
        return refreshDetail();
      }).catch(() => {});
    });
  }

  function importList() {
    API.pickOpen('选择要导入的 MD5 列表').then((p) => {
      if (!p) return;
      API.importList(p).then((r) => {
        toast(r.message || '已导入');
        Shell.reloadLists().then(() => { renderListItems(); if (r.listId) select(r.listId); });
      }).catch(() => {});
    }).catch(() => {});
  }

  /* ---------------------------------------------- 生命周期 */

  function mount(root) {
    host = root;
    host.classList.add('page-lists');
    host.innerHTML = shellHtml();
    bindSearch(host, (v) => { S.filter = v; renderListItems(); });
    renderListItems();
    // 回页面时 activeId 可能还在但 meta 已被清掉（例如删除流程中途切走），补加载一次
    if (S.activeId && !S.meta) refreshDetail();
    else renderDetail();
  }

  window.Pages = window.Pages || {};
  window.Pages.lists = {
    id: 'lists', title: '列表管理', subtitle: '叠加 · 另存 · 导入导出 · 备注', icon: 'layers',
    mount,
    unmount() {
      if (host) host.classList.remove('page-lists');
      host = null;
    },
    // 页面功能按钮统一放在底部功能区
    actions() {
      const id = S.activeId;
      const sel = S.selection.size;
      return [
        { id: 'import', label: '导入', icon: 'download', variant: 'text', onClick: importList },
        { id: 'export', label: '导出', icon: 'upload', variant: 'text', disabled: !id, onClick: () => exportDialog(id) },
        { divider: true },
        { id: 'reveal', label: '定位', icon: 'folderOpen', variant: 'text', disabled: !id, onClick: () => revealListFile(id) },
        { id: 'copy', label: '复制', icon: 'copy', variant: 'text', disabled: !id, onClick: () => copyAs(id) },
        { id: 'del', label: '删除', icon: 'trash', variant: 'text', disabled: !id && !sel, onClick: () => (sel ? removeSelected() : removeList(id)) },
      ];
    },
    select(id) { select(id); },
    status() {
      const n = State.lists.length;
      const c = State.lists.reduce((a, b) => a + (b.count || 0), 0);
      const sz = State.lists.reduce((a, b) => a + (b.totalSize || 0), 0);
      const sel = S.selection.size;
      let txt = '共 ' + num(n) + ' 个列表 · ' + num(c) + ' 条记录 · ' + bytes(sz);
      if (sel) txt += ' · 已选 ' + num(sel) + ' 个';
      return ICO('layers', 14) + '<span class="ab-text">' + txt + '</span>';
    },
  };

})();
