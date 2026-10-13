/* ============================================================
   复合控件：分页器 / 路径单元格 / 统计块 / 搜索框
   ============================================================ */
(function () {
  const { esc, num, bytes, splitPath, debounce } = UI;

  /** 分页器：返回 HTML，并通过 onGo(offset) 回调 */
  function pagerHtml(page) {
    const total = page.total || 0;
    const off = page.offset || 0;
    const lim = page.limit || 100;
    const from = total === 0 ? 0 : off + 1;
    const to = Math.min(off + lim, total);
    const pageNo = Math.floor(off / lim) + 1;
    const pages = Math.max(1, Math.ceil(total / lim));
    return (
      '<div class="pager">' +
      '<span>' + num(from) + '–' + num(to) + ' / ' + num(total) + '</span>' +
      '<span class="spacer"></span>' +
      '<span>第 ' + num(pageNo) + ' / ' + num(pages) + ' 页</span>' +
      '<button class="icon-btn icon-btn--sm" data-pg="first"' + (off <= 0 ? ' disabled' : '') + '>' + ICO('chevLeft', 18) + '</button>' +
      '<button class="icon-btn icon-btn--sm" data-pg="prev"' + (off <= 0 ? ' disabled' : '') + '>' + ICO('back', 18) + '</button>' +
      '<button class="icon-btn icon-btn--sm" data-pg="next"' + (off + lim >= total ? ' disabled' : '') + '>' + ICO('chevRight', 18) + '</button>' +
      '</div>'
    );
  }

  /**
   * 绑定分页器交互
   * @param {HTMLElement} host 容器
   * @param {object} page 分页数据
   * @param {function(number):void} onGo 传入新的 offset
   */
  function bindPager(host, page, onGo) {
    const lim = page.limit || 100;
    const total = page.total || 0;
    const off = page.offset || 0;
    UI.$$('[data-pg]', host).forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.pg;
        if (k === 'first') onGo(0);
        else if (k === 'prev') onGo(Math.max(0, off - lim));
        else if (k === 'next') onGo(off + lim);
        else if (k === 'last') onGo(Math.max(0, (Math.ceil(total / lim) - 1) * lim));
      };
    });
  }

  /** 路径单元格 */
  function pathCell(p, extra) {
    const s = splitPath(p || '');
    return '<div class="row-path">' + ICO('file', 16) +
      '<span class="p-name truncate" title="' + esc(p) + '">' + esc(s.name) + '</span>' +
      (extra || '') +
      '<span class="p-dir truncate" title="' + esc(s.dir) + '">' + esc(s.dir) + '</span></div>';
  }

  /** 统计块 */
  function statGrid(items) {
    return '<div class="stats">' + items.map((it) =>
      '<div class="stat ' + (it.tone ? 'stat--' + it.tone : '') + '">' +
      '<div class="stat-value">' + esc(it.value) + '</div>' +
      '<div class="stat-label">' + esc(it.label) + '</div></div>').join('') + '</div>';
  }

  /** 搜索框 */
  function searchBox(placeholder, value) {
    return '<div class="search">' + ICO('search', 18) +
      '<input type="text" placeholder="' + esc(placeholder || '搜索') + '" value="' + esc(value || '') + '">' +
      '</div>';
  }

  function bindSearch(host, fn, wait) {
    const inp = UI.$('.search input', host);
    if (!inp) return;
    const run = debounce(() => fn(inp.value.trim()), wait || 240);
    inp.addEventListener('input', run);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') fn(inp.value.trim()); });
  }

  /** 排序表头 */
  function thSort(label, key, sort, desc, cls) {
    const on = sort === key;
    return '<th class="sortable ' + (cls || '') + '" data-sort="' + key + '">' + esc(label) +
      (on ? ' ' + ICO(desc ? 'chevDown' : 'chevDown', 14) : '') + '</th>';
  }

  /* ------------------------------------------------ 自绘下拉选择 */

  /**
   * 生成 MD3 下拉选择控件（替代原生 select）
   * @param {{id:string,label:string,value?:any,options:Array<[any,string]>,width?:string,disabled?:boolean,cls?:string}} o
   */
  function selectHtml(o) {
    o = o || {};
    const opts = (o.options || []).map((x) => [String(x[0]), String(x[1])]);
    if (!opts.length) opts.push(['', '—']);
    const v = (o.value === undefined || o.value === null) ? '' : String(o.value);
    const cur = opts.find((x) => x[0] === v) || opts[0];
    return '<div class="field field--select' + (o.cls ? ' ' + o.cls : '') + (o.disabled ? ' is-disabled' : '') + '"' +
      ' data-sel="' + esc(o.id) + '"' +
      ' data-value="' + esc(cur[0]) + '"' +
      ' data-opts="' + esc(JSON.stringify(opts)) + '"' +
      (o.width ? ' style="width:' + o.width + '"' : '') + '>' +
      '<button class="select-btn" type="button"' + (o.disabled ? ' disabled' : '') + '>' +
        '<span class="sel-text">' + esc(cur[1]) + '</span>' +
        '<span class="caret">' + ICO('chevDown', 20) + '</span>' +
      '</button>' +
      '<label>' + esc(o.label || '') + '</label>' +
      '</div>';
  }

  function selEl(host, id) { return UI.$('[data-sel="' + id + '"]', host); }

  /** 读取当前值 */
  function selValue(host, id) {
    const el = selEl(host, id);
    return el ? el.dataset.value : '';
  }

  /** 重新设置选项（用于异步填充的列表下拉） */
  function setSelectOptions(host, id, options, value) {
    const el = selEl(host, id);
    if (!el) return;
    const opts = (options || []).map((x) => [String(x[0]), String(x[1])]);
    el.dataset.opts = JSON.stringify(opts);
    const v = (value === undefined || value === null) ? el.dataset.value : String(value);
    const cur = opts.find((x) => x[0] === v) || opts[0] || ['', '—'];
    el.dataset.value = cur[0];
    const t = UI.$('.sel-text', el);
    if (t) t.textContent = cur[1];
  }

  /**
   * 绑定容器内所有下拉
   * @param {HTMLElement} host 容器
   * @param {(id:string, value:string) => void} [onChange]
   */
  function bindSelects(host, onChange) {
    UI.$$('.field--select', host).forEach((el) => {
      const btn = UI.$('.select-btn', el);
      if (!btn || btn.disabled) return;
      btn.onclick = (e) => {
        e.stopPropagation();
        let opts = [];
        try { opts = JSON.parse(el.dataset.opts || '[]'); } catch (err) { opts = []; }
        UI.showMenu(btn, opts.map((o) => ({
          label: o[1],
          icon: o[0] === el.dataset.value ? 'check' : '',
          onSelect: () => {
            el.dataset.value = o[0];
            const t = UI.$('.sel-text', el);
            if (t) t.textContent = o[1];
            if (onChange) onChange(el.dataset.sel, o[0]);
          },
        })));
      };
    });
  }

  window.W = {
    pagerHtml, bindPager, pathCell, statGrid, searchBox, bindSearch, thSort,
    selectHtml, selValue, selEl, setSelectOptions, bindSelects,
  };
})();
