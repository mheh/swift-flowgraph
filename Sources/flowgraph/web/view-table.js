'use strict';
// The table view: the scope as rows that sort and filter. One mode has a row for each symbol, the other a row for each edge.
// With no root, the table holds every symbol that the filters of the page allow.
(() => {
  const { state, esc, EDGE_COLOR } = FG;
  const H = 24;  // the height of one row, which the window of drawn rows needs
  const num = (key, title, tip) => ({ key, title, tip, num: true, width: '76px', value: (n, c) => c[key] });
  const SYMBOL_COLUMNS = [
    { key: 'name', title: 'symbol', width: 'minmax(240px, 2.4fr)', value: n => n.name.toLowerCase() },
    { key: 'kind', title: 'kind', width: '120px', value: n => n.kind },
    { key: 'module', title: 'module', width: 'minmax(90px, .8fr)', value: n => n.module || '' },
    { key: 'where', title: 'file:line', width: 'minmax(160px, 1.6fr)', value: n => n.file < 0 ? '~' : FG.model.files[n.file] + ':' + String(n.line).padStart(7, '0') },
    { key: 'dist', title: 'distance', tip: 'The steps from the nearest root. + is a symbol that you added by hand.', num: true, width: '76px', value: n => FG.scope.dist.get(n.id) ?? Infinity },
    num('calledBy', 'called by', 'The functions that call it, in the whole project.'),
    num('calls', 'calls', 'The functions that its body calls.'),
    num('reads', 'reads', 'The variables and properties that its body reads.'),
    num('writes', 'writes', 'The variables and properties that its body writes.'),
    num('uses', 'uses', 'The types that its body names.'),
    num('usedBy', 'used by', 'The symbols that read it, write it, or name it, with no call.'),
    { key: 'throws', title: 'throws', tip: 'The places where an error leaves the function: each throw, and each try that no catch takes.', num: true, width: '64px',
      value: n => FG.exits(n.id).filter(e => (e.type === 'throw' || e.type === 'try') && !e.caught).length },
    { key: 'async', title: 'async', tip: 'The function is async.', num: true, width: '54px', value: n => (FG.body(n.id) || {}).async ? 1 : 0, show: v => v ? '✓' : '' },
    { key: 'marked', title: '▣ sites', tip: 'The places in its own body that use a symbol that is marked for replacement.', num: true, width: '64px',
      value: n => FG.state.marks.length ? FG.model.out[n.id].reduce((sum, e) => sum + (FG.isMarked(e.to) ? e.count : 0), 0) : 0 },
    { key: 'state', title: 'diff', tip: 'With a base snapshot chosen (Diff…): the state of the symbol against the base.', num: true, width: '110px',
      value: n => ['', 'affected', 'body', 'signature', 'removed', 'added'].indexOf(n.diff || ''), show: v => v ? `<span class="dst d-${['', 'affected', 'body', 'signature', 'removed', 'added'][v]}">${['', 'affected', 'body changed', 'signature', 'removed', 'added'][v]}</span>` : '' },
  ];
  const EDGE_COLUMNS = [
    { key: 'from', title: 'from', width: 'minmax(200px, 2fr)', value: e => FG.model.N[e.from].name.toLowerCase() },
    { key: 'kind', title: 'kind', width: '90px', value: e => e.kind },
    { key: 'to', title: 'to', width: 'minmax(200px, 2fr)', value: e => FG.model.N[e.to].name.toLowerCase() },
    { key: 'where', title: 'first site', width: 'minmax(160px, 1.4fr)', value: e => site(e, true) },
    { key: 'count', title: 'sites', tip: 'How many times the body of "from" does this.', num: true, width: '76px', value: e => e.count },
    { key: 'diff', title: 'diff', tip: 'With a base snapshot chosen: the edge is added or removed, or the count of its sites changed.', width: '110px', value: e => e.diff || (e.was != null ? 'sites' : '') },
  ];

  let box, head, scroller, spacer, body, bar;
  let mode = FG.params.get('rows') === 'edges' ? 'edges' : 'symbols', filter = FG.params.get('filter') || '';
  const sort = { symbols: { key: null, down: false }, edges: { key: null, down: false } };
  const opened = new Set();  // the symbols whose callers and callees are listed under them
  let rows = [], shownIds = new Set(), counts = null, countsOf = null;

  // The file and line of the site of an edge: a site is in the file of the symbol that the edge leaves.
  function site(e, sortable) {
    const n = FG.model.N[e.from];
    if (n.file < 0) return sortable ? '~' : '';
    return FG.model.files[n.file] + ':' + (sortable ? String(e.line).padStart(7, '0') : e.line);
  }
  // The counts of each symbol come from the whole project, so that they do not change with the depth.
  function count() {
    const M = FG.model;
    if (countsOf === M) return;
    countsOf = M;
    counts = M.N.map(() => ({ calledBy: 0, calls: 0, reads: 0, writes: 0, uses: 0, usedBy: 0 }));
    for (const e of M.E) {
      if (e.kind === 'calls') { counts[e.from].calls++; counts[e.to].calledBy++; }
      else {
        if (e.kind === 'reads' || e.kind === 'writes' || e.kind === 'uses') counts[e.from][e.kind]++;
        if (e.kind !== 'inherits' && e.kind !== 'dispatch') counts[e.to].usedBy++;
      }
    }
  }

  const columns = () => mode === 'edges' ? EDGE_COLUMNS : SYMBOL_COLUMNS;
  const grid = () => `grid-template-columns:${columns().map(c => c.width).join(' ')}`;
  const terms = () => filter.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text, ts) => ts.every(t => text.includes(t));

  function build(scope) {
    const { N, out, inc, files } = FG.model, ts = terms(), s = sort[mode];
    const ids = state.roots.size ? scope.order : N.filter(FG.allowed).map(n => n.id);
    shownIds = new Set(ids);
    const order = (list, value) => {
      const col = columns().find(c => c.key === s.key);
      if (!col) return list;
      const keyed = list.map(x => [value(col, x), x]);
      keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) * (s.down ? -1 : 1));
      return keyed.map(k => k[1]);
    };
    rows = [];
    if (mode === 'edges') {
      let edges = [];
      for (const id of ids) for (const e of out[id]) if (shownIds.has(e.to) && !state.off.has(e.kind)) edges.push(e);
      if (ts.length) edges = edges.filter(e => matches(`${N[e.from].name} ${e.kind} ${N[e.to].name} ${site(e)}`.toLowerCase(), ts));
      rows = order(edges, (col, e) => col.value(e)).map(edge => ({ edge }));
      return;
    }
    let syms = ids.map(id => N[id]);
    if (ts.length) syms = syms.filter(n => matches(`${n.name} ${n.kind} ${n.module} ${n.file >= 0 ? files[n.file] : ''}`.toLowerCase(), ts));
    for (const n of order(syms, (col, n) => col.value(n, counts[n.id]))) {
      rows.push({ id: n.id });
      if (!opened.has(n.id)) continue;
      // Under an open symbol: who uses it, then what its body holds in the order of the source.
      for (const e of [...inc[n.id]].sort((a, b) => N[a.from].name.localeCompare(N[b.from].name))) rows.push({ sub: e, other: e.from, arrow: '←' });
      for (const e of [...out[n.id]].sort((a, b) => a.line - b.line)) rows.push({ sub: e, other: e.to, arrow: '→' });
    }
  }

  const cell = (text, cls = '', tip = '') => `<span class="${cls}"${tip ? ` title="${esc(tip)}"` : ''}>${text}</span>`;
  const dot = n => `<i class="dot ${n.cls}"></i>`;
  function rowHTML(r) {
    const { N, out, inc } = FG.model;
    if (r.edge) {
      const e = r.edge, a = N[e.from], b = N[e.to];
      return `<div class="tr${state.selected === e.from || state.selected === e.to ? ' picked' : ''}" data-id="${e.from}" data-to="${e.to}" style="${grid()}">`
        + cell(dot(a) + esc(a.name), 'name', a.name) + cell(e.kind, '', '').replace('<span', `<span style="color:${EDGE_COLOR[e.kind]}"`)
        + cell(dot(b) + esc(b.name), 'name to', b.name) + cell(esc(site(e)), 'dim', site(e)) + cell(e.count, 'n')
        + cell(e.diff ? `<span class="dst d-${e.diff}">${e.diff}</span>` : e.was != null ? `<span class="dst d-body">${e.was} → ${e.count} sites</span>` : '') + '</div>';
    }
    if (r.sub) {
      const e = r.sub, n = N[r.other];
      const sign = e.diff === 'added' ? '<span class="dst d-added">+</span> ' : e.diff === 'removed' ? '<span class="dst d-removed">−</span> ' : '';
      return `<div class="tr sub${shownIds.has(n.id) ? '' : ' absent'}" data-id="${n.id}" style="${grid()}">`
        + cell(`<b class="arrow">${r.arrow}</b>${sign}` + dot(n) + esc(n.name), 'name', n.name) + `<span style="color:${EDGE_COLOR[e.kind]}">${e.kind}</span>`
        + cell(esc(n.module || ''), 'dim') + cell(esc(site(e)), 'dim', site(e)) + cell(e.count > 1 ? '×' + e.count : '', 'n dim') + '</div>';
    }
    const n = N[r.id], c = counts[n.id], d = FG.scope.dist.get(n.id), where = FG.where(n);
    const can = out[n.id].length + inc[n.id].length > 0;
    return `<div class="tr${state.selected === n.id ? ' picked' : ''}${state.roots.has(n.id) ? ' root' : ''}${FG.isMarked(n.id) ? ' marked' : ''}${n.diff === 'removed' ? ' gone' : ''}" data-id="${n.id}" style="${grid()}">`
      + cell(`<b class="tw" data-tw="${n.id}">${can ? (opened.has(n.id) ? '▾' : '▸') : ''}</b>` + dot(n) + esc(n.name), 'name', n.name)
      + cell(esc(n.kind), 'dim') + cell(esc(n.module || ''), 'dim') + cell(esc(where), 'dim', where)
      + cell(d == null ? '' : Number.isInteger(d) ? d : '+', 'n')
      + SYMBOL_COLUMNS.slice(5).map(col => { const v = col.value(n, c); return cell(col.show ? col.show(v) : v || '', 'n'); }).join('') + '</div>';
  }

  // Only the rows in the window are in the document, so a table of every symbol stays fast.
  function paint() {
    const first = Math.max(0, Math.floor(scroller.scrollTop / H) - 15), last = Math.min(rows.length, Math.ceil((scroller.scrollTop + scroller.clientHeight) / H) + 15);
    body.style.top = first * H + 'px';
    body.innerHTML = rows.slice(first, last).map(rowHTML).join('');
  }
  function paintHead() {
    const s = sort[mode];
    head.style.cssText = grid();
    head.innerHTML = columns().map(c => `<span class="${c.num ? 'n' : ''}" data-sort="${c.key}" title="${esc(c.tip || '')}">${esc(c.title)}${s.key === c.key ? (s.down ? ' ▾' : ' ▴') : ''}</span>`).join('');
  }
  function say() {
    const { N, E } = FG.model, what = mode === 'edges' ? 'edges' : 'symbols', total = mode === 'edges' ? rows.length : rows.filter(r => r.id != null).length;
    FG.status(`${total} ${what}` + (filter.trim() ? ' match the filter' : '') + (state.roots.size ? '' : ` · no root: the whole project of ${N.length} symbols and ${E.length} edges`));
  }
  function redraw() { build(FG.scope); spacer.style.height = rows.length * H + 'px'; paintHead(); paint(); say(); }

  const view = {
    id: 'table', title: 'Table',

    mount(viewbox, viewbar) {
      const style = document.createElement('style');
      style.textContent = `
        .tbl { position:absolute; inset:0; display:flex; flex-direction:column; font-size:12px; }
        .tbl .th, .tbl .tr { display:grid; column-gap:10px; padding:0 12px; align-items:center; }
        .tbl .th { height:28px; flex:none; background:var(--panel); border-bottom:1px solid var(--line); color:var(--dim); text-transform:uppercase; font-size:10px; letter-spacing:.04em; padding-right:26px; }
        .tbl .th span { cursor:pointer; white-space:nowrap; overflow:hidden; } .tbl .th span:hover { color:var(--text); }
        .tbl .scroll { flex:1; overflow-y:scroll; min-height:0; position:relative; }
        .tbl .rows { position:absolute; left:0; right:0; }
        .tbl .tr { height:${H}px; cursor:pointer; border-bottom:1px solid #20242c; }
        .tbl .tr > span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .tbl .tr:hover { background:#222733; } .tbl .tr.picked { background:#2a3550; } .tbl .tr.root .name { font-weight:bold; color:#fff; }
        .tbl .tr.marked .name { color:#f0a0e6; } .tbl .tr.gone .name { color:#f08a7a; text-decoration:line-through; }
        .tbl .tr.sub { background:#191c22; } .tbl .tr.sub .name { padding-left:26px; } .tbl .tr.absent .name { color:var(--dim); }
        .tbl .n { text-align:right; font-variant-numeric:tabular-nums; }
        .tbl .dot { display:inline-block; margin-right:6px; }
        .tbl .tw { display:inline-block; width:16px; color:var(--dim); } .tbl .tw:hover { color:#fff; }
        .tbl .arrow { display:inline-block; width:18px; color:var(--dim); font-weight:normal; }
        .tbl .empty { padding:30px; color:var(--dim); text-align:center; }`;
      document.head.appendChild(style);
      box = viewbox;
      box.innerHTML = `<div class="tbl"><div class="th"></div><div class="scroll"><div class="spacer"><div class="rows"></div></div></div></div>`;
      head = box.querySelector('.th'); scroller = box.querySelector('.scroll'); spacer = box.querySelector('.spacer'); body = box.querySelector('.rows');
      scroller.onscroll = paint;
      new ResizeObserver(() => { if (box.classList.contains('on') && FG.model) paint(); }).observe(scroller);
      head.onclick = ev => {
        const key = ev.target.dataset.sort, s = sort[mode];
        if (!key) return;
        // A number column starts with the largest first. A third click gives the order of the scope back.
        const numeric = columns().find(c => c.key === key).num && key !== 'dist';
        if (s.key !== key) { s.key = key; s.down = numeric; }
        else if (s.down === numeric) s.down = !numeric;
        else s.key = null;
        redraw();
      };
      body.onclick = ev => {
        const tw = ev.target.closest('[data-tw]'), tr = ev.target.closest('.tr');
        if (tw && tw.textContent) { const id = +tw.dataset.tw; opened.has(id) ? opened.delete(id) : opened.add(id); redraw(); }
        else if (tr) FG.select(+(ev.target.closest('.to') ? tr.dataset.to : tr.dataset.id), view);
      };
      body.ondblclick = ev => { const tr = ev.target.closest('.tr'); if (tr && !ev.target.closest('[data-tw]')) FG.setRoot(+(ev.target.closest('.to') ? tr.dataset.to : tr.dataset.id), ev.shiftKey); };
      body.oncontextmenu = ev => { const tr = ev.target.closest('.tr'); ev.preventDefault(); if (tr && state.roots.size) FG.hide(+tr.dataset.id); };
      // The arrow keys move the selection through the symbol rows.
      document.addEventListener('keydown', ev => {
        if (!box.classList.contains('on') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || mode !== 'symbols') return;
        if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
        const step = ev.key === 'ArrowDown' ? 1 : -1;
        let i = rows.findIndex(r => r.id === state.selected);
        for (i += step; i >= 0 && i < rows.length && rows[i].id == null; i += step);
        if (i >= 0 && i < rows.length) { ev.preventDefault(); FG.select(rows[i].id, view); reveal(i, false); }
      });
      view.bar(viewbar);
    },

    // The controls that only this view has.
    bar(viewbar) {
      bar = viewbar;
      bar.innerHTML = `<label>rows <select><option value="symbols">symbols</option><option value="edges">edges</option></select></label>`
        + `<input type="search" placeholder="Filter the rows…" style="width:220px" title="Each word must be in the name, the kind, the module, or the file of the row.">`;
      const select = bar.querySelector('select'), input = bar.querySelector('input');
      select.value = mode; input.value = filter;
      select.onchange = () => { mode = select.value; scroller.scrollTop = 0; redraw(); };
      input.oninput = () => { filter = input.value; scroller.scrollTop = 0; redraw(); };
    },

    reset() { opened.clear(); scroller.scrollTop = 0; },
    has: id => shownIds.has(id),
    update() { count(); redraw(); },
    select(id, fromOutside) {
      if (fromOutside && id != null) { const i = rows.findIndex(r => r.id === id || (r.edge && r.edge.from === id)); if (i >= 0) reveal(i, true); }
      paint();
    },
    get rows() { return rows; },
  };
  // Scrolls so that one row is in the window: to the middle for a jump, or only as far as necessary for a step.
  function reveal(i, middle) {
    const top = i * H, low = scroller.scrollTop, high = low + scroller.clientHeight - H;
    if (middle) { if (top < low || top > high) scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 2); }
    else if (top < low) scroller.scrollTop = top;
    else if (top > high) scroller.scrollTop = top - scroller.clientHeight + H;
  }
  FG.registerView(view);
})();
