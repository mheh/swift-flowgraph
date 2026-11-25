'use strict';
// The trace view: the body of one function as an outline of its steps, in the order of the source.
// A step is a statement or a branch. Each call can be opened in place, so a path can be followed down to its return or its throw.
(() => {
  const { state, esc, EDGE_COLOR } = FG;
  const MAX_ROWS = 6000;
  let box, list, headBox, focus = null, ownSelection = null, rootsKey = '';
  const opened = new Set();  // the calls that are opened in place, each by the path of its row

  const MARK = { return: '⏎', throw: '✗' };
  const hasBody = id => id != null && FG.body(id) != null;
  const rootsOf = () => [...state.roots].join(',');

  // Which function the view shows: the one that another part of the page selected, or else the first root with a body.
  function settle() {
    const key = rootsOf();
    if (state.selected !== ownSelection && hasBody(state.selected)) focus = state.selected;
    else if (key !== rootsKey || !hasBody(focus)) focus = [...state.roots].find(hasBody) ?? (hasBody(focus) ? focus : null);
    rootsKey = key; ownSelection = state.selected;
  }

  // An operator of the standard library says nothing that the text of the step does not say. The same is true of the call
  // that the compiler puts in for a literal or for a string with values in it: init(arrayLiteral:), appendInterpolation(_:).
  const inText = name => { const last = name.split('.').pop(); return !/^[A-Za-z_]/.test(last) || /^init\((\w+Literal|stringInterpolation|literalCapacity)\b/.test(last) || /^append(Interpolation|Literal)\(/.test(last); };

  function refsHTML(step, path) {
    const { N } = FG.model, byKind = {};
    for (const r of step.refs) (byKind[r.kind] = byKind[r.kind] || []).push(r.to);
    let html = '';
    const mark = id => N[id].diff && !N[id].ext ? `<i class="dst d-${N[id].diff}" title="${FG.diff.labels[N[id].diff]}">${FGDiff.SIGN[N[id].diff]}</i> ` : '';
    for (const id of byKind.calls || []) {
      if (N[id].sys && !FG.isMarked(id) && inText(N[id].name)) continue;
      const n = N[id], can = hasBody(id), key = path + '>' + id;
      html += `<span class="call${FG.isMarked(id) ? ' marked' : ''}${state.selected === id ? ' picked' : ''}" data-id="${id}" title="${esc(n.name)} · ${esc(FG.where(n))}">`
        + (can ? `<b data-exp="${key}">${opened.has(key) ? '▾' : '▸'}</b>` : '') + (FG.isMarked(id) ? '▣ ' : '') + mark(id) + esc(FG.short(n)) + '</span>';
    }
    // What is read, written, and named comes after the calls, each kind in its colour. A marked symbol is always named.
    for (const kind of ['refs', 'writes', 'reads', 'uses']) {
      const ids = byKind[kind];
      if (!ids) continue;
      const marked = ids.filter(FG.isMarked), rest = ids.filter(id => !FG.isMarked(id) && !(N[id].sys && kind === 'refs'));
      for (const id of marked) html += `<span class="call marked" data-id="${id}" title="${kind} ${esc(N[id].name)}">▣ ${esc(FG.short(N[id]))}</span>`;
      const shown = kind === 'uses' ? [] : rest.slice(0, kind === 'reads' ? 2 : 3);
      for (const id of shown) html += `<span class="ref" data-id="${id}" style="color:${EDGE_COLOR[kind]}" title="${kind} ${esc(N[id].name)}">${esc(FG.short(N[id]))}</span>`;
      if (rest.length > shown.length) html += `<span class="more" title="${esc(kind + ': ' + rest.slice(shown.length).map(id => N[id].name).join(', '))}">${shown.length ? '+' : ''}${rest.length - shown.length} ${kind}</span>`;
    }
    return html;
  }

  const indent = depth => `style="padding-left:${depth * 18}px"`;
  const effectsOf = b => `${b.async ? ' · async' : ''}${b.throws ? ' · throws' : ''}`;
  const badge = n => n.diff ? `<span class="dst d-${n.diff}">${FG.diff.labels[n.diff]}</span>` : '';

  const keyword = s => {
    if (s.kind === 'stmt') return '';
    return `<b class="kw k-${s.kind.replace(/\W/g, '')}">${MARK[s.kind] ? MARK[s.kind] + ' ' : ''}${esc(s.kind)}</b> `;
  };

  function flagsHTML(s) {
    const handled = s.flags & 2;
    const tryTitle = handled ? 'try? or try!: the error stops here' : 'try: an error leaves this function here, unless a catch takes it';
    return (s.flags & 1 ? `<i class="try${handled ? ' handled' : ''}" title="${tryTitle}">try</i>` : '')
      + (s.flags & 4 ? '<i class="await" title="await: the function can be suspended here">await</i>' : '');
  }

  // The row of the base for a step whose first line changed. The row of the head follows it.
  function baseRow(s, before, depth, inner, path) {
    const word = s.kind === 'stmt' ? '' : `<b class="kw">${esc(s.kind)}</b> `;
    return `<div class="tl del${inner}"><span class="ln">−${s.was.line}</span><span class="tx" ${indent(depth)}>${word}${before}</span>`
      + `<span class="rf">${refsHTML({ refs: s.was.refs }, path + 'b')}</span></div>`;
  }

  function stepRow(s, text, depth, isTop, path) {
    const textChanged = s.diff === '~' && s.was.text !== s.text;
    const sign = s.diff === '+' || textChanged ? '+' : s.diff === '-' ? '−' : s.diff === '~' ? '~' : '';
    const diffClass = { '+': ' add', '−': ' del', '~': ' chg' }[sign] || '';
    const marked = s.refs.some(r => FG.isMarked(r.to));
    let note = '';
    if (s.diff === '~' && !textChanged) {
      const why = s.was.hash !== s.hash ? 'its text changed past the first line' : 'what it uses or its try and await changed';
      note = `<i class="note" title="The first line is the same. The step is not: ${why}.">changed</i>`;
    }
    return `<div class="tl${diffClass}${marked ? ' marked' : ''}${isTop ? '' : ' inner'}" data-line="${s.line}" data-top="${isTop ? 1 : 0}">`
      + `<span class="ln">${sign}${s.line}</span>`
      + `<span class="tx" ${indent(depth)}>${marked ? '<b class="mk">▣</b>' : ''}${keyword(s)}${text}${flagsHTML(s)}${note}</span>`
      + `<span class="rf">${refsHTML(s, path)}</span></div>`;
  }

  function calleeRow(id, body, depth, again) {
    const callee = FG.model.N[id];
    const where = esc(FG.where(callee)) + effectsOf(body) + (again ? ' · it is open above: a recursion' : '');
    return `<div class="tl into" data-id="${id}"><span class="ln"></span>`
      + `<span class="tx" ${indent(depth)}>↳ <b>${esc(callee.name)}</b>${callee.diff ? ' ' + badge(callee) : ''} <span class="dim">${where}</span></span>`
      + '<span class="rf"></span></div>';
  }

  // What a step calls, each with the path of the row that names it. A callee that only the step of the base calls opens too.
  function calleesOf(s, path) {
    const now = s.refs.map(r => [r, path]);
    if (s.diff !== '~') return now;
    const gone = s.was.refs.filter(r => !s.refs.some(x => x.to === r.to && x.kind === r.kind));
    return now.concat(gone.map(r => [r, path + 'b']));
  }

  // The rows of the outline of one function, with each opened call in place.
  function rowsOf(id) {
    const rows = [];
    let full = false;
    // chain: the functions that are open above this row. A function that is in it already is not opened again.
    const walk = (steps, depth, path, chain) => steps.forEach((s, i) => {
      if (rows.length >= MAX_ROWS) { full = true; return; }
      const p = path + '/' + i, isTop = chain.length === 1;
      // A changed step is two rows: the step of the base, then the step of the head, with the words that are not in both marked.
      let text = esc(s.text);
      if (s.diff === '~' && s.was.text !== s.text) {
        const [before, after] = FGDiff.words(s.was.text, s.text);
        rows.push(baseRow(s, before, depth, isTop ? '' : ' inner', p));
        text = after;
      }
      rows.push(stepRow(s, text, depth, isTop, p));
      for (const [r, from] of calleesOf(s, p)) {
        const key = from + '>' + r.to, body = FG.body(r.to);
        const opens = r.kind === 'calls' || (s.kind === 'entry' && r.kind === 'refs');
        if (!opens || !opened.has(key) || !body) continue;
        const again = chain.includes(r.to);
        rows.push(calleeRow(r.to, body, depth + 1, again));
        if (!again) walk(body.steps, depth + 2, key, [...chain, r.to]);
      }
      if (s.children.length) walk(s.children, depth + 1, p, chain);
    });
    walk(FG.body(id).steps, 0, String(id), [id]);
    return { rows, full };
  }

  function headHTML(n, b) {
    const effects = x => [x.async && 'async', x.throws && 'throws'].filter(Boolean).join(' ') || 'no effect';
    const sides = { both: 'the base and the head as one', head: 'the head: the new code', base: 'the base: the old code' };
    const side = FG.model.merged ? sides[FG.state.side] : '';
    return `<b>${esc(n.name)}</b> ${n.diff ? badge(n) + ' ' : ''}<span class="dim">${esc(n.kind)}${effectsOf(b)} · ${esc(FG.where(n))}–${b.endLine}</span>`
      + (b.was ? ` <span class="dst d-removed">− ${effects(b.was)}</span> <span class="dst d-added">+ ${effects(b)}</span>` : '')
      + (side ? ` <span class="dim">· ${side}</span>` : '');
  }

  function statusText(count, full) {
    const exits = FG.exits(focus), n = cls => list.querySelectorAll('.tl.' + cls).length;
    const returns = exits.filter(e => e.type === 'return' || e.type === 'end').length;
    const errors = exits.filter(e => (e.type === 'throw' || e.type === 'try') && !e.caught).length;
    const changes = FG.model.merged && FG.state.side === 'both' ? `+${n('add')} −${n('del')}${n('chg') ? ' ~' + n('chg') : ''} · ` : '';
    return changes + `${count} steps` + (full ? ` — the first ${MAX_ROWS}: close a call to see the rest` : '')
      + ` · ${returns} returns, ${errors} places where an error leaves`;
  }

  function render() {
    if (focus == null) {
      const none = Object.keys(FG.model.bodies).length
        ? 'Select a function, or make one the root, to see what its body does.'
        : 'This snapshot has no bodies. The export had no source files to read them from, or it ran with --no-bodies.';
      headBox.innerHTML = '';
      list.innerHTML = `<div class="none">${none}</div>`;
      FG.status('');
      return;
    }
    headBox.innerHTML = headHTML(FG.model.N[focus], FG.body(focus));
    const { rows, full } = rowsOf(focus);
    list.innerHTML = rows.join('') || '<div class="none">The body is empty.</div>';
    FG.status(statusText(rows.length, full), full);
  }

  const view = {
    id: 'trace', title: 'Trace',

    mount(viewbox) {
      const style = document.createElement('style');
      style.textContent = `
        .trc { position:absolute; inset:0; display:flex; flex-direction:column; }
        .trc .hd { flex:none; padding:8px 12px; background:var(--panel); border-bottom:1px solid var(--line); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .trc .ls { flex:1; overflow:auto; min-height:0; font:12px/1.5 ui-monospace, Menlo, monospace; padding:6px 0 40px; }
        .trc .tl { display:grid; grid-template-columns:52px minmax(300px, 3fr) minmax(200px, 2fr); column-gap:12px; padding:1px 12px; align-items:baseline; }
        .trc .tl:hover { background:#1e222b; } .trc .tl.flash { background:#33415f; }
        .trc .tl.inner { background:#181b21; } .trc .tl.into { background:#1b2230; color:#9db8e8; cursor:pointer; }
        .trc .tl.add, .exit.add { background:#16301f; } .trc .tl.del, .exit.del { background:#3a1c1c; } .trc .tl.chg { background:#2b2914; }
        .trc .tl.add .ln { color:#7fd88f; } .trc .tl.del .ln { color:#f08a7a; } .trc .tl.chg .ln { color:#e0d070; }
        .trc u.w { text-decoration:none; border-radius:2px; } .trc .tl.add u.w { background:#2b6a3e; color:#fff; } .trc .tl.del u.w { background:#7a2f2a; color:#fff; }
        .trc .note { font-style:normal; font-size:10px; border-radius:3px; padding:0 4px; margin-left:6px; background:#33301a; color:#e0d070; font-family:-apple-system, sans-serif; }
        .trc .call i.dst { font-style:normal; padding:0 3px; }
        .trc .tl.marked { box-shadow:inset 3px 0 #e05ad0; }
        .trc .ln { color:#5d6472; text-align:right; }
        .trc .tx { white-space:pre-wrap; word-break:break-word; }
        .trc .rf { display:flex; flex-wrap:wrap; gap:3px 6px; font-family:-apple-system, "Segoe UI", sans-serif; font-size:11px; }
        .trc .kw { color:#c58fd4; font-weight:normal; } .trc .k-return { color:#8fd48f; } .trc .k-throw { color:#e6705a; font-weight:bold; }
        .trc .k-closure, .trc .k-func, .trc .k-entry, .trc .k-defer, .trc .k-accessor { color:#8a91a0; }
        .trc .try, .trc .await { font-style:normal; font-size:10px; border-radius:3px; padding:0 4px; margin-left:6px; font-family:-apple-system, sans-serif; }
        .trc .try { background:#4a2620; color:#f0a090; } .trc .try.handled { background:#2a2d35; color:#8a91a0; text-decoration:line-through; }
        .trc .await { background:#22344a; color:#8fc0f0; }
        .trc .call { border:1px solid #2f5f8a; border-radius:3px; padding:0 5px; cursor:pointer; white-space:nowrap; color:#bcd9f2; }
        .trc .call:hover, .trc .call.picked { border-color:#fff; color:#fff; }
        .trc .call b { color:var(--dim); margin-right:4px; } .trc .call b:hover { color:#fff; }
        .trc .call.marked, .trc .mk { border-color:#e05ad0; color:#f0a0e6; } .trc .mk { margin-right:5px; font-weight:normal; }
        .trc .ref { cursor:pointer; white-space:nowrap; opacity:.8; } .trc .ref:hover { opacity:1; text-decoration:underline; }
        .trc .more { color:#5d6472; white-space:nowrap; }
        .trc .none { padding:40px; color:var(--dim); text-align:center; font-family:-apple-system, sans-serif; }
        .exit { display:flex; gap:6px; padding:2px 4px; border-radius:3px; cursor:pointer; align-items:baseline; } .exit:hover { background:#2a3040; }
        .exit .w { color:var(--dim); font-size:11px; } .exit .x { color:#e6705a; } .exit .r { color:#8fd48f; } .exit.caught { opacity:.55; }
        .exit code { font:11px ui-monospace, Menlo, monospace; word-break:break-word; }`;
      document.head.appendChild(style);
      box = viewbox;
      box.innerHTML = `<div class="trc"><div class="hd"></div><div class="ls"></div></div>`;
      headBox = box.querySelector('.hd'); list = box.querySelector('.ls');
      list.onclick = ev => {
        const exp = ev.target.closest('[data-exp]'), el = ev.target.closest('[data-id]');
        if (exp) { const k = exp.dataset.exp; opened.has(k) ? opened.delete(k) : opened.add(k); render(); }
        else if (el) { ownSelection = +el.dataset.id; FG.select(ownSelection, view); }
      };
      list.ondblclick = ev => { const el = ev.target.closest('[data-id]'); if (el && !ev.target.closest('[data-exp]')) FG.setRoot(+el.dataset.id, ev.shiftKey); };
    },

    reset() { opened.clear(); focus = null; ownSelection = null; rootsKey = ''; },
    has: id => FG.scope.dist.has(id),
    update() { settle(); render(); },
    select(id, fromOutside) {
      if (fromOutside && hasBody(id)) { focus = id; ownSelection = id; }
      render();
    },

    // The side panel of this view starts with the ways out of the function, and the marked sites below it.
    panel() {
      if (focus == null) return '';
      const { N } = FG.model, ex = FG.exits(focus);
      const row = e => {
        const sign = e.type === 'return' || e.type === 'end' ? '<b class="r">⏎</b>' : '<b class="x">✗</b>';
        const what = e.type === 'end' ? 'the end of the body' : e.type === 'try'
          ? 'try' + (e.callees.length ? ' ← ' + e.callees.map(c => esc(FG.short(N[c]))).join(', ') : '') : `${e.type} <code>${esc(e.text)}</code>`;
        const when = e.when.length ? `<div class="w">when: ${esc(e.when.join(' → '))}</div>` : '';
        return `<div class="exit${e.caught ? ' caught' : ''}${e.diff === '+' ? ' add' : e.diff === '-' ? ' del' : ''}" data-goto="${e.line}"><span>${e.diff === '+' ? '+' : e.diff === '-' ? '−' : ''}${sign}</span><span class="dim">:${e.line}</span><span>${what}${e.caught ? ' <span class="w">· a catch takes it</span>' : ''}${when}</span></div>`;
      };
      let html = `<h3>Ways out of ${esc(FG.short(N[focus]))} · ${ex.length}</h3>` + (ex.map(row).join('') || '<span class="dim">none</span>');
      if (state.marks.length) {
        const sites = FG.markedBelow(focus);
        html += `<h3>Marked for replacement, in this path · ${sites.length}</h3>` + (sites.slice(0, 300).map(s =>
          `<div class="exit" data-id="${s.fn}"${s.fn === focus ? ` data-goto="${s.line}"` : ''}><span style="color:#f0a0e6">▣</span><span class="dim">${s.fn === focus ? '' : esc(FG.short(N[s.fn]))}:${s.line}</span><span>${esc(FG.short(N[s.to]))}</span></div>`).join('')
          || '<span class="dim">This path uses nothing that is marked.</span>');
      }
      return html;
    },
    panelClick(ev) {
      const el = ev.target.closest('[data-goto]');
      if (!el) return false;
      const row = [...list.querySelectorAll(`.tl[data-top="1"][data-line="${el.dataset.goto}"]`)][0];
      if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 900); }
      return true;
    },
    get focus() { return focus; },
  };
  FG.registerView(view);
})();
