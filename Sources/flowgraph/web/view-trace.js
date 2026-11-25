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
    const mark = id => N[id].diff && !N[id].ext ? `<i class="dst d-${N[id].diff}" title="${FGDiff.LABEL[N[id].diff]}">${FGDiff.SIGN[N[id].diff]}</i> ` : '';
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

  function render() {
    const { N } = FG.model, rows = [];
    let full = false;
    // chain: the functions that are open above this row. A function that is in it already is not opened again.
    const walk = (steps, depth, path, chain) => {
      steps.forEach((s, i) => {
        if (rows.length >= MAX_ROWS) { full = true; return; }
        const p = path + '/' + i, marked = s.refs.some(r => FG.isMarked(r.to));
        // A changed step is two rows: the step of the base, then the step of the head, with the words that are not in both marked.
        let text = esc(s.text), note = '';
        if (s.diff === '~') {
          if (s.was.text !== s.text) {
            const [before, after] = FGDiff.words(s.was.text, s.text);
            text = after;
            rows.push(`<div class="tl del${chain.length > 1 ? ' inner' : ''}"><span class="ln">−${s.was.line}</span><span class="tx" style="padding-left:${depth * 18}px">${s.kind === 'stmt' ? '' : `<b class="kw">${esc(s.kind)}</b> `}${before}</span><span class="rf">${refsHTML({ refs: s.was.refs }, p + 'b')}</span></div>`);
          } else note = `<i class="note" title="The first line is the same. The step is not: ${s.was.hash !== s.hash ? 'its text changed past the first line' : 'what it uses or its try and await changed'}.">changed</i>`;
        }
        const sign = s.diff === '+' || (s.diff === '~' && s.was.text !== s.text) ? '+' : s.diff === '-' ? '−' : s.diff === '~' ? '~' : '';
        const dcls = sign === '+' ? ' add' : sign === '−' ? ' del' : sign === '~' ? ' chg' : '';
        const tried = s.flags & 1 ? `<i class="try${s.flags & 2 ? ' handled' : ''}" title="${s.flags & 2 ? 'try? or try!: the error stops here' : 'try: an error leaves this function here, unless a catch takes it'}">try</i>` : '';
        const waits = s.flags & 4 ? `<i class="await" title="await: the function can be suspended here">await</i>` : '';
        const word = s.kind === 'stmt' ? '' : `<b class="kw k-${s.kind.replace(/\W/g, '')}">${MARK[s.kind] ? MARK[s.kind] + ' ' : ''}${esc(s.kind)}</b> `;
        rows.push(`<div class="tl${dcls}${marked ? ' marked' : ''}${chain.length > 1 ? ' inner' : ''}" data-line="${s.line}" data-top="${chain.length === 1 ? 1 : 0}">`
          + `<span class="ln">${sign}${s.line}</span><span class="tx" style="padding-left:${depth * 18}px">${marked ? '<b class="mk">▣</b>' : ''}${word}${text}${tried}${waits}${note}</span>`
          + `<span class="rf">${refsHTML(s, p)}</span></div>`);
        // A callee that only the step of the base calls opens too.
        const callees = s.refs.map(r => [r, p]).concat(s.diff === '~' ? s.was.refs.filter(r => !s.refs.some(x => x.to === r.to && x.kind === r.kind)).map(r => [r, p + 'b']) : []);
        for (const [r, from] of callees) {
          if (r.kind !== 'calls' && !(s.kind === 'entry' && r.kind === 'refs')) continue;
          const key = from + '>' + r.to;
          if (!opened.has(key)) continue;
          const callee = N[r.to], b = FG.body(r.to);
          if (!b) continue;
          const again = chain.includes(r.to);
          rows.push(`<div class="tl into" data-id="${r.to}"><span class="ln"></span><span class="tx" style="padding-left:${(depth + 1) * 18}px">↳ <b>${esc(callee.name)}</b>${callee.diff ? ` <span class="dst d-${callee.diff}">${FGDiff.LABEL[callee.diff]}</span>` : ''}`
            + ` <span class="dim">${esc(FG.where(callee))}${b.async ? ' · async' : ''}${b.throws ? ' · throws' : ''}${again ? ' · it is open above: a recursion' : ''}</span></span><span class="rf"></span></div>`);
          if (!again) walk(b.steps, depth + 2, key, [...chain, r.to]);
        }
        if (s.children.length) walk(s.children, depth + 1, p, chain);
      });
    };
    if (focus == null) {
      headBox.innerHTML = '';
      list.innerHTML = `<div class="none">${Object.keys(FG.model.bodies).length ? 'Select a function, or make one the root, to see what its body does.' : 'This snapshot has no bodies. The export had no source files to read them from, or it ran with --no-bodies.'}</div>`;
      FG.status('');
      return;
    }
    const n = N[focus], b = FG.body(focus);
    const effects = x => [x.async && 'async', x.throws && 'throws'].filter(Boolean).join(' ') || 'no effect';
    const side = FG.model.merged ? { both: 'the base and the head as one', head: 'the head: the new code', base: 'the base: the old code' }[FG.state.side] : '';
    headBox.innerHTML = `<b>${esc(n.name)}</b> ${n.diff ? `<span class="dst d-${n.diff}">${FGDiff.LABEL[n.diff]}</span> ` : ''}<span class="dim">${esc(n.kind)}${b.async ? ' · async' : ''}${b.throws ? ' · throws' : ''} · ${esc(FG.where(n))}–${b.endLine}</span>`
      + (b.was ? ` <span class="dst d-removed">− ${effects(b.was)}</span> <span class="dst d-added">+ ${effects(b)}</span>` : '') + (side ? ` <span class="dim">· ${side}</span>` : '');
    walk(b.steps, 0, String(focus), [focus]);
    list.innerHTML = rows.join('') || '<div class="none">The body is empty.</div>';
    const ex = FG.exits(focus), plus = list.querySelectorAll('.tl.add').length, minus = list.querySelectorAll('.tl.del').length, other = list.querySelectorAll('.tl.chg').length;
    FG.status((FG.model.merged && FG.state.side === 'both' ? `+${plus} −${minus}${other ? ' ~' + other : ''} · ` : '') + `${rows.length} steps` + (full ? ` — the first ${MAX_ROWS}: close a call to see the rest` : '') + ` · ${ex.filter(e => e.type === 'return' || e.type === 'end').length} returns, ${ex.filter(e => (e.type === 'throw' || e.type === 'try') && !e.caught).length} places where an error leaves`, full);
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
