'use strict';
// The summary of a diff: how many symbols have each state, what the change does to each entry point, and the list of the changed symbols.
// The comparison itself is in diff.js, and every view shows it. A symbol that is chosen here opens in the trace.
(() => {
  const { esc, state } = FG;
  const { LABEL, SIGN, ORDER } = FGDiff;
  let box, listBox, detail, headBox, filter = '';
  const shownStates = new Set(['added', 'removed', 'signature', 'body']);
  const chip = s => `<span class="dst d-${s}">${SIGN[s]} ${LABEL[s]}</span>`;

  // --- the marks, in one of the two snapshots
  function markedSet(model) {
    const set = new Set(), modules = new Set(state.marks.filter(k => k[0] === 'm').map(k => k.slice(2))), usrs = new Set(state.marks.filter(k => k[0] === 'u').map(k => k.slice(2)));
    const add = id => { if (set.has(id)) return; set.add(id); for (const k of model.kids[id]) add(k); };
    for (const n of model.N) if (modules.has(n.module) || usrs.has(n.usr)) add(n.id);
    return set;
  }
  function reachOf(model, from) {
    const seen = new Set([from]), queue = [from];
    while (queue.length) for (const e of model.out[queue.pop()]) if ((e.kind === 'calls' || e.kind === 'refs' || e.kind === 'dispatch') && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    return seen;
  }
  // The sites that use a marked symbol: in the whole snapshot, or in what one symbol reaches.
  function markedSites(model, set, from) {
    const site = e => set.has(e.to) && !set.has(e.from) ? e.count : 0;
    if (from == null) return model.E.reduce((sum, e) => sum + site(e), 0);
    let sum = 0;
    for (const id of reachOf(model, from)) for (const e of model.out[id]) sum += site(e);
    return sum;
  }

  function renderHead(D) {
    const name = m => esc([m.name, m.project.branch, m.project.commit].filter(Boolean).join(' · ') || 'snapshot');
    let html = `<span class="dim">${name(D.base)} → ${name(D.head)}</span> `
      + ORDER.map(s => `<label class="dst d-${s}${shownStates.has(s) ? '' : ' off'}"><input type="checkbox" data-state="${s}"${shownStates.has(s) ? ' checked' : ''}>${SIGN[s]} ${D.counts[s]} ${LABEL[s]}</label>`).join(' ');
    if (state.marks.length) {
      const before = markedSites(D.base, markedSet(D.base)), after = markedSites(D.head, markedSet(D.head));
      html += ` <span class="dst d-mark" title="The sites that use what is marked for replacement: in the base, and in the head.">▣ ${after} of ${before} marked sites left</span>`;
    }
    headBox.innerHTML = html + ` <input class="df" placeholder="Filter…" value="${esc(filter)}">`;
  }

  function renderList(D) {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const ok = n => !n.ext && terms.every(w => n.name.toLowerCase().includes(w) || (n.module || '').toLowerCase().includes(w));
    let html = '', total = 0;
    for (const s of ORDER) {
      if (!shownStates.has(s)) continue;
      const rows = D.N.filter(n => n.diff === s && ok(n)).sort((a, b) => (a.module + a.name).localeCompare(b.module + b.name));
      if (!rows.length) continue;
      total += rows.length;
      html += `<h3>${LABEL[s]} · ${rows.length}</h3>` + rows.slice(0, 1500).map(n =>
        `<div class="dr${state.selected === n.id ? ' on' : ''}" data-id="${n.id}" title="${esc(n.name)}"><span class="dst d-${s}">${SIGN[s]}</span>`
        + `<span class="nm">${n.entry ? '⏵ ' : ''}${esc(FG.short(n))}${s === 'signature' && D.bodyToo.has(n.id) ? ' <i>+ body</i>' : ''}</span><span class="dim">${esc(n.module || '')}</span></div>`).join('')
        + (rows.length > 1500 ? `<div class="dim">… ${rows.length - 1500} more: filter the list</div>` : '');
    }
    listBox.innerHTML = html || '<div class="none">No symbol has one of the chosen states.</div>';
    FG.status(`${total} symbols in the list`);
  }

  // What the change does to each entry point.
  function overview(D) {
    const H = D.head, B = D.base, entries = H.entries.slice(0, 200), marks = state.marks.length > 0;
    const headSet = marks ? markedSet(H) : null, baseSet = marks ? markedSet(B) : null;
    const rows = entries.map(n => {
      const reach = reachOf(H, n.id), by = {};
      for (const id of reach) { const s = D.N[id].diff; if (s && s !== 'affected' && !D.N[id].ext) by[s] = (by[s] || 0) + 1; }
      const b = D.baseOf.get(n.id);
      return { n, s: D.N[n.id].diff, by, before: marks && b != null ? markedSites(B, baseSet, b) : null, after: marks ? markedSites(H, headSet, n.id) : null };
    });
    const gone = D.N.filter(n => n.diff === 'removed' && n.entry);
    if (!rows.length && !gone.length) return '<div class="none">The project has no entry point. Choose a symbol in the list.</div>';
    const change = r => r.before == null ? '' : r.after < r.before ? ` <span class="dst d-added">−${r.before - r.after}</span>` : r.after > r.before ? ` <span class="dst d-removed">+${r.after - r.before}</span>` : '';
    return `<h2>Entry points · ${rows.filter(r => r.s).length} of ${rows.length} are changed or reach a change</h2>`
      + `<div class="dt"><div class="dh"><span>entry point</span><span>state</span><span>changed symbols that it reaches</span>${marks ? '<span>▣ sites: base → head</span>' : ''}</div>`
      + rows.sort((x, y) => (y.s ? 1 : 0) - (x.s ? 1 : 0) || (x.n.module + x.n.name).localeCompare(y.n.module + y.n.name)).map(r =>
        `<div class="dh dr" data-id="${r.n.id}"><span><b>${esc(FG.short(r.n))}</b> <span class="dim">${esc(r.n.module)}</span></span><span>${r.s ? chip(r.s) : '<span class="dim">the same</span>'}</span>`
        + `<span>${ORDER.filter(s => r.by[s]).map(s => `<span class="dst d-${s}">${SIGN[s]} ${r.by[s]}</span>`).join(' ') || '<span class="dim">none</span>'}</span>`
        + (marks ? `<span>${r.before == null ? '<span class="dim">new</span>' : r.before} → ${r.after}${change(r)}</span>` : '') + '</div>').join('')
      + gone.map(n => `<div class="dh dr" data-id="${n.id}"><span><b>${esc(FG.short(n))}</b> <span class="dim">${esc(n.module)}</span></span><span>${chip('removed')}</span><span></span>${marks ? '<span></span>' : ''}</div>`).join('') + '</div>'
      + `<p class="dim">A click on a symbol opens it in the trace, with its two bodies as one list of steps. A double click makes it the root.<br>`
      + `The graph and the table show the same change: <b>show</b> and <b>side</b> at the top choose what they hold.</p>`;
  }

  function render() {
    const D = FG.diff;
    if (!D) {
      headBox.innerHTML = ''; listBox.innerHTML = '';
      detail.innerHTML = `<div class="none"><p><b>Compare two snapshots</b></p><p>The snapshot of the page is the head. Choose the snapshot that it is compared with, for example one of the main branch.</p>`
        + `<p><button data-choose>Choose the base in the library…</button></p></div>`;
      FG.status('');
      return;
    }
    renderHead(D);
    detail.innerHTML = overview(D);
    renderList(D);
  }

  const view = {
    id: 'diff', title: 'Changes',
    mount(viewbox) {
      const style = document.createElement('style');
      style.textContent = `
        .dif { position:absolute; inset:0; display:flex; flex-direction:column; }
        .dif .hd { flex:none; padding:7px 12px; background:var(--panel); border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center; }
        .dif .hd label { cursor:pointer; } .dif .hd label.off { opacity:.45; } .dif .hd input[type=checkbox] { margin:0 4px 0 0; }
        .dif .df { margin-left:auto; width:180px; }
        .dif .bd { flex:1; display:flex; min-height:0; }
        .dif .li { flex:none; width:360px; overflow:auto; border-right:1px solid var(--line); padding:0 8px 30px; }
        .dif .de { flex:1; overflow:auto; padding:6px 16px 40px; min-width:0; }
        .dif h2 { font-size:15px; margin:10px 0 4px; } .dif h3 { margin:14px 0 4px; }
        .dif .dr { display:flex; gap:6px; align-items:baseline; padding:2px 4px; border-radius:3px; cursor:pointer; white-space:nowrap; }
        .dif .dr:hover { background:#232733; } .dif .dr.on { background:#2d3a55; }
        .dif .dr .nm { overflow:hidden; text-overflow:ellipsis; flex:1; } .dif .dr i { color:var(--dim); font-size:11px; }
        .dif .dt .dh { display:grid; grid-template-columns:minmax(200px, 2fr) 150px minmax(200px, 2fr) 170px; gap:10px; padding:3px 4px; border-bottom:1px solid #20242c; align-items:baseline; }
        .dif .dt .dh:first-child { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
        .dif .none { padding:40px; color:var(--dim); text-align:center; }`;
      document.head.appendChild(style);
      box = viewbox;
      box.innerHTML = `<div class="dif"><div class="hd"></div><div class="bd"><div class="li"></div><div class="de"></div></div></div>`;
      headBox = box.querySelector('.hd'); listBox = box.querySelector('.li'); detail = box.querySelector('.de');
      box.onclick = ev => {
        const row = ev.target.closest('.dr');
        if ('choose' in ev.target.dataset) FG.chooseBase();
        else if (row) {
          const id = +row.dataset.id;
          // A symbol that one side does not have needs both sides to be seen.
          if (!FG.model.onSide(FG.model.N[id])) FG.setSide('both');
          FG.select(id, view);
          if (FG.body(id)) FG.activate('trace');
        }
      };
      box.onchange = ev => { const s = ev.target.dataset.state; if (s) { ev.target.checked ? shownStates.add(s) : shownStates.delete(s); render(); } };
      box.oninput = ev => { if (ev.target.classList.contains('df')) { filter = ev.target.value; renderList(FG.diff); } };
      box.ondblclick = ev => { const row = ev.target.closest('.dr'); if (row) FG.setRoot(+row.dataset.id, ev.shiftKey); };
    },
    has: () => true,
    update() { render(); },
    select() { if (FG.diff) renderList(FG.diff); },
  };
  FG.registerView(view);
})();
