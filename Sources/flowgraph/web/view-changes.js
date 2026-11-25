'use strict';
// The summary of a diff: how many symbols have each state, what the change does to each entry point, and the list of the changed symbols.
// The comparison itself is in diff.js, and every view shows it. A symbol that is chosen here opens in the trace.
(() => {
  const { esc, state } = FG;
  const { SIGN, ORDER } = FGDiff;
  let box, listBox, detail, headBox, filter = '';
  const shownStates = new Set(['added', 'removed', 'signature', 'body']);
  const chip = s => `<span class="dst d-${s}">${SIGN[s]} ${FG.diff.labels[s]}</span>`;

  const MAX_LIST = 1500;
  const FOLLOWED = new Set(['calls', 'refs', 'dispatch']);
  const ACROSS_TITLE = 'The two snapshots share few identities, so they are of two projects. A symbol of one is matched with the symbol '
    + 'of the other that has its name. A pair differs when the two do not call the same functions.';
  const MARK_TITLE = 'The sites that use what is marked for replacement: in the base, and in the head.';
  const NO_BASE = '<div class="none"><p><b>Compare two snapshots</b></p><p>The snapshot of the page is the head. '
    + 'Choose the snapshot that it is compared with, for example one of the main branch.</p>'
    + '<p><button data-choose>Choose the base in the library…</button></p></div>';
  const HELP = '<p class="dim">A click on a symbol opens it in the trace, with its two bodies as one list of steps. A double click makes it the root.<br>'
    + 'The graph and the table show the same change: <b>show</b> and <b>side</b> at the top choose what they hold.</p>';

  // The marked symbols of one of the two snapshots, with their members.
  function markedSet(model) {
    const marked = letter => new Set(state.marks.filter(k => k[0] === letter).map(k => k.slice(2)));
    const set = new Set(), modules = marked('m'), usrs = marked('u');
    const add = id => { if (set.has(id)) return; set.add(id); for (const k of model.kids[id]) add(k); };
    for (const n of model.N) if (modules.has(n.module) || usrs.has(n.usr)) add(n.id);
    return set;
  }
  function reachOf(model, from) {
    const seen = new Set([from]), queue = [from];
    while (queue.length) {
      for (const e of model.out[queue.pop()]) {
        if (FOLLOWED.has(e.kind) && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
      }
    }
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

  function stateBox(D, s) {
    const on = shownStates.has(s);
    return `<label class="dst d-${s}${on ? '' : ' off'}"><input type="checkbox" data-state="${s}"${on ? ' checked' : ''}>`
      + `${SIGN[s]} ${D.counts[s]} ${D.labels[s]}</label>`;
  }
  function renderHead(D) {
    const name = m => esc([m.name, m.project.branch, m.project.commit].filter(Boolean).join(' · ') || 'snapshot');
    let html = `<span class="dim">${name(D.base)} → ${name(D.head)}</span> `
      + (D.across ? `<span class="dst" title="${ACROSS_TITLE}">two projects · ${D.named.size} pairs by name</span> ` : '')
      + ORDER.map(s => stateBox(D, s)).join(' ');
    if (state.marks.length) {
      const before = markedSites(D.base, markedSet(D.base)), after = markedSites(D.head, markedSet(D.head));
      html += ` <span class="dst d-mark" title="${MARK_TITLE}">▣ ${after} of ${before} marked sites left</span>`;
    }
    headBox.innerHTML = html + ` <input class="df" placeholder="Filter…" value="${esc(filter)}">`;
  }

  function listRow(D, n, s) {
    const bodyToo = s === 'signature' && D.bodyToo.has(n.id) ? ' <i>+ body</i>' : '';
    return `<div class="dr${state.selected === n.id ? ' on' : ''}" data-id="${n.id}" title="${esc(n.name)}"><span class="dst d-${s}">${SIGN[s]}</span>`
      + `<span class="nm">${n.entry ? '⏵ ' : ''}${esc(FG.short(n))}${bodyToo}</span><span class="dim">${esc(n.module || '')}</span></div>`;
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
      html += `<h3>${D.labels[s]} · ${rows.length}</h3>` + rows.slice(0, MAX_LIST).map(n => listRow(D, n, s)).join('')
        + (rows.length > MAX_LIST ? `<div class="dim">… ${rows.length - MAX_LIST} more: filter the list</div>` : '');
    }
    listBox.innerHTML = html || '<div class="none">No symbol has one of the chosen states.</div>';
    FG.status(`${total} symbols in the list`);
  }

  // Of two projects: how much of each module of the base the head has. A function that several binaries compile counts in each.
  function portRows(D) {
    const rows = new Map();
    const rowOf = module => rows.get(module) || rows.set(module, { module, all: 0, same: 0, body: 0, removed: 0, partners: new Map() }).get(module);
    for (const n of D.base.N) {
      if (n.ext || FGAcross.classOf(n.kind) !== 'callable') continue;
      const row = rowOf(n.module), pair = D.N[D.mid.get(n.id)];
      row.all++;
      row[pair.diff === 'removed' ? 'removed' : pair.diff === 'body' ? 'body' : 'same']++;
      if (pair.diff !== 'removed') row.partners.set(pair.module, (row.partners.get(pair.module) || 0) + 1);
    }
    return [...rows.values()].sort((x, y) => y.all - x.all);
  }

  function portLine(r) {
    const share = r.all ? Math.round(100 * r.same / r.all) + '%' : '';
    const cell = (s, count) => count ? `<span class="dst d-${s}">${count}</span>` : '<span class="dim">0</span>';
    const partner = [...r.partners].sort((x, y) => y[1] - x[1])[0];
    return `<div class="dh dr" data-module="${esc(r.module)}"><span><b>${esc(r.module)}</b></span>`
      + `<span class="dim">${partner ? esc(partner[0]) : 'none'}</span><span>${r.all}</span>`
      + `<span>${r.same} <span class="dim">${share}</span></span><span>${cell('body', r.body)}</span><span>${cell('removed', r.removed)}</span></div>`;
  }
  function portSummary(D) {
    const rows = portRows(D), sum = key => rows.reduce((total, r) => total + r[key], 0);
    return `<h2>The functions of the base · ${sum('all') - sum('removed')} of ${sum('all')} have a pair in the head</h2>`
      + '<div class="dt port"><div class="dh"><span>module of the base</span><span>most pairs are in</span><span>functions</span>'
      + `<span>same calls</span><span>${D.labels.body}</span><span>${D.labels.removed}</span></div>${rows.map(portLine).join('')}</div>`
      + '<p class="dim">A click on a module puts its name in the filter of the list.</p>';
  }

  // What the change does to each entry point: its state, the changed symbols that it reaches, and its marked sites on each side.
  function entryRows(D, marks) {
    const H = D.head, B = D.base, headSet = marks ? markedSet(H) : null, baseSet = marks ? markedSet(B) : null;
    const rows = H.entries.slice(0, 200).map(n => {
      const by = {}, b = D.baseOf.get(n.id);
      for (const id of reachOf(H, n.id)) {
        const s = D.N[id].diff;
        if (s && s !== 'affected' && !D.N[id].ext) by[s] = (by[s] || 0) + 1;
      }
      const before = marks && b != null ? markedSites(B, baseSet, b) : null;
      return { n, s: D.N[n.id].diff, by, before, after: marks ? markedSites(H, headSet, n.id) : null };
    });
    return rows.sort((x, y) => (y.s ? 1 : 0) - (x.s ? 1 : 0) || (x.n.module + x.n.name).localeCompare(y.n.module + y.n.name));
  }

  const entryName = n => `<span><b>${esc(FG.short(n))}</b> <span class="dim">${esc(n.module)}</span></span>`;
  function sitesCell(r) {
    const change = r.before == null ? '' : r.after < r.before ? ` <span class="dst d-added">−${r.before - r.after}</span>`
      : r.after > r.before ? ` <span class="dst d-removed">+${r.after - r.before}</span>` : '';
    return `<span>${r.before == null ? '<span class="dim">new</span>' : r.before} → ${r.after}${change}</span>`;
  }
  function entryLine(r, marks) {
    const reached = ORDER.filter(s => r.by[s]).map(s => `<span class="dst d-${s}">${SIGN[s]} ${r.by[s]}</span>`).join(' ');
    return `<div class="dh dr" data-id="${r.n.id}">${entryName(r.n)}<span>${r.s ? chip(r.s) : '<span class="dim">the same</span>'}</span>`
      + `<span>${reached || '<span class="dim">none</span>'}</span>${marks ? sitesCell(r) : ''}</div>`;
  }
  function overview(D) {
    const marks = state.marks.length > 0, rows = entryRows(D, marks);
    const gone = D.N.filter(n => n.diff === 'removed' && n.entry);
    if (!rows.length && !gone.length) return '<div class="none">The project has no entry point. Choose a symbol in the list.</div>';
    const goneLine = n => `<div class="dh dr" data-id="${n.id}">${entryName(n)}<span>${chip('removed')}</span><span></span>${marks ? '<span></span>' : ''}</div>`;
    return `<h2>Entry points · ${rows.filter(r => r.s).length} of ${rows.length} are changed or reach a change</h2>`
      + '<div class="dt"><div class="dh"><span>entry point</span><span>state</span><span>changed symbols that it reaches</span>'
      + `${marks ? '<span>▣ sites: base → head</span>' : ''}</div>`
      + rows.map(r => entryLine(r, marks)).join('') + gone.map(goneLine).join('') + '</div>' + HELP;
  }

  function render() {
    const D = FG.diff;
    if (!D) {
      headBox.innerHTML = ''; listBox.innerHTML = '';
      detail.innerHTML = NO_BASE;
      FG.status('');
      return;
    }
    renderHead(D);
    detail.innerHTML = (D.across ? portSummary(D) : '') + overview(D);
    renderList(D);
  }

  function open(id) {
    // A symbol that one side does not have needs both sides to be seen.
    if (!FG.model.onSide(FG.model.N[id])) FG.setSide('both');
    FG.select(id, view);
    if (FG.body(id)) FG.activate('trace');
  }
  function click(ev) {
    const row = ev.target.closest('.dr'), module = ev.target.closest('[data-module]');
    if ('choose' in ev.target.dataset) FG.chooseBase();
    else if (module) { filter = module.dataset.module; render(); }
    else if (row) open(+row.dataset.id);
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
        .dif .dt .dh { display:grid; grid-template-columns:minmax(200px, 2fr) 150px minmax(200px, 2fr) 170px; gap:10px; padding:3px 4px; }
        .dif .dt .dh { border-bottom:1px solid #20242c; align-items:baseline; }
        .dif .dt.port .dh { grid-template-columns:minmax(160px, 2fr) minmax(140px, 2fr) 80px 110px 100px 120px; }
        .dif .dt .dh:first-child { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
        .dif .none { padding:40px; color:var(--dim); text-align:center; }`;
      document.head.appendChild(style);
      box = viewbox;
      box.innerHTML = `<div class="dif"><div class="hd"></div><div class="bd"><div class="li"></div><div class="de"></div></div></div>`;
      headBox = box.querySelector('.hd'); listBox = box.querySelector('.li'); detail = box.querySelector('.de');
      box.onclick = click;
      box.onchange = ev => {
        const s = ev.target.dataset.state;
        if (!s) return;
        ev.target.checked ? shownStates.add(s) : shownStates.delete(s);
        render();
      };
      box.oninput = ev => { if (ev.target.classList.contains('df')) { filter = ev.target.value; renderList(FG.diff); } };
      box.ondblclick = ev => { const row = ev.target.closest('.dr'); if (row) FG.setRoot(+row.dataset.id, ev.shiftKey); };
    },
    has: () => true,
    update() { render(); },
    select() { if (FG.diff) renderList(FG.diff); },
  };
  FG.registerView(view);
})();
