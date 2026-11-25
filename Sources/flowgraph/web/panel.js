'use strict';
// The side panel: the roots, what is hidden, and the selected symbol with who uses it and what its body holds.
const FGPanel = (() => {
  const { state, esc, short, EDGE_COLOR, row: rowHTML, markKey, body, inProduct, where, toggleMark, refresh, setEntry, hide, show, restore, toggleOpen, setRoot, select } = FG;
  const $ = id => document.getElementById(id);
  const MAX_ROWS = 400;
  const HELP = '<p class="dim">Click a symbol to see who calls and uses it. Double-click it to make it the root. Shift adds a root.<br>'
    + 'Right-click or <b>h</b> hides a symbol. <b>e</b> shows all its neighbours.</p>';

  const drawn = id => FG.active && FG.active.has ? FG.active.has(id) : FG.scope.dist.has(id);

  // A row with a switch: − takes a shown symbol out, + shows one that is not shown.
  function panelRow(n, extra) {
    const on = drawn(n.id);
    return rowHTML(n, extra)
      .replace('<span class="dot', `<b class="sw" data-sw="${n.id}" title="${on ? 'Hide' : 'Show'}">${on ? '−' : '+'}</b><span class="dot`)
      .replace('class="row"', `class="row${on ? '' : ' absent'}"`);
  }

  function edgeRow(e, end) {
    const { N, files } = FG.model, site = N[e.from];
    const sign = e.diff === 'added' ? '<span class="dst d-added">+</span> ' : e.diff === 'removed' ? '<span class="dst d-removed">−</span> ' : '';
    const file = site.file >= 0 ? files[site.file].split('/').pop() : '';
    return panelRow(N[e[end]], sign + esc(`${file}:${e.line}${e.count > 1 ? ' ×' + e.count : ''}`));
  }

  // The edges of one symbol, one group for each kind. `end` is the end of the edge that the rows show.
  function list(title, edges, end) {
    const { N } = FG.model, byKind = {};
    for (const e of edges) (byKind[e.kind] = byKind[e.kind] || []).push(e);
    let html = '';
    for (const kind of FG.model.edgeKinds) {
      const es = byKind[kind];
      if (!es) continue;
      es.sort((a, b) => end === 'to' ? a.line - b.line : N[a[end]].name.localeCompare(N[b[end]].name));
      html += `<h3><span style="color:${EDGE_COLOR[kind]}">${kind}</span> ${title} · ${es.length}</h3>`;
      html += es.slice(0, MAX_ROWS).map(e => edgeRow(e, end)).join('');
      if (es.length > MAX_ROWS) html += `<div class="dim">… and ${es.length - MAX_ROWS} more</div>`;
    }
    return html;
  }

  function rootsHTML() {
    const { N } = FG.model;
    const chips = [...state.roots].map(r => `<span class="chip">${esc(short(N[r]))} <b data-drop="${r}">×</b></span>`).join('');
    let html = `<h3>Roots</h3>${chips || '<span class="dim">none</span>'}`;
    if (state.hidden.size) {
      html += `<h3>Hidden · ${state.hidden.size} <button data-unhide="all">Show all</button></h3>`
        + [...state.hidden].map(h => `<span class="chip off">${esc(short(N[h]))} <b data-unhide="${h}">×</b></span>`).join('');
    }
    return html;
  }

  // With no root: the entry points, and the functions that nothing in the project calls.
  function startHTML() {
    const { N, out, inc } = FG.model;
    const called = n => inc[n.id].some(e => e.kind === 'calls' || e.kind === 'refs' || e.kind === 'dispatch');
    const tops = N.filter(n => n.cls === 'fn' && !n.ext && inProduct(n) && !called(n) && out[n.id].length)
      .sort((a, b) => out[b.id].length - out[a.id].length).slice(0, 60);
    const entries = FG.model.entries.filter(inProduct);
    let html = '';
    if (state.product) {
      const advice = entries.length ? '' : ' and no marked entry point: pick a function below, or find one';
      html += `<p class="dim">The product ${esc(state.product)} has ${N.filter(inProduct).length} symbols${advice}.</p>`;
    }
    if (entries.length) {
      html += `<h3>Entry points · ${entries.length}</h3>` + entries.map(n => rowHTML(n, esc(n.module)).replace('data-id', 'data-entry')).join('');
    }
    return html + '<h3>Functions with no caller · largest first</h3>'
      + tops.map(n => rowHTML(n, esc(n.module) + ' · ' + out[n.id].length + ' edges')).join('');
  }

  function actionsHTML(n) {
    const id = n.id, key = markKey(n), moduleKey = 'm:' + n.module;
    const scope = !drawn(id) ? `<button data-show="${id}">Show</button>`
      : `<button data-open="${id}">${state.open.has(id) ? 'Collapse neighbours' : 'Expand neighbours'}</button>`
        + (state.roots.has(id) ? '' : `<button data-hide="${id}">Hide</button>`);
    const mark = `<button data-mark="${esc(key)}">${state.marks.includes(key) ? 'Unmark' : '▣ Mark for replacement'}</button>`;
    const markModule = !n.module ? ''
      : `<button data-mark="${esc(moduleKey)}">${state.marks.includes(moduleKey) ? 'Unmark' : '▣ Mark'} module ${esc(n.module)}</button>`;
    return `<div class="actions"><button data-root="${id}">Make root</button><button data-add="${id}">Add as root</button>${scope}${mark}${markModule}</div>`;
  }

  function symbolHTML(id) {
    const { N, out, inc, kids, decl, doc } = FG.model, n = N[id], b = body(id);
    const change = n.diff ? ` · <span class="dst d-${n.diff}">${FG.diff.labels[n.diff]}</span>` : '';
    let html = `<h3>${esc(n.kind)}${change}</h3><h2>${esc(n.name)}</h2><div class="dim">${esc(where(n))}</div>`;
    if (decl[id]) html += `<pre>${esc(decl[id])}</pre>`;
    if (doc[id]) html += `<div>${esc(doc[id])}</div>`;
    html += actionsHTML(n);
    if (n.label) html += `<div class="dim">An entry point: the project hands it to <code>${esc(n.label)}</code></div>`;
    if (b) html += `<div class="dim">${[b.async && 'async', b.throws && 'throws'].filter(Boolean).join(' · ')}</div>`;
    if (kids[id].length) {
      html += `<h3>Members · ${kids[id].length}</h3>`
        + kids[id].slice(0, 200).map(k => panelRow(N[k], `${inc[k].length} in · ${out[k].length} out`)).join('');
    }
    return html + list('— used by', inc[id], 'from') + list('— in its body, in source order', out[id], 'to');
  }

  function render() {
    if (!FG.model) { $('side').innerHTML = ''; return; }
    const ofView = FG.active && FG.active.panel ? FG.active.panel() : '';
    const rest = state.selected != null ? symbolHTML(state.selected) : HELP + (state.roots.size ? '' : startHTML());
    $('side').innerHTML = rootsHTML() + ofView + rest;
  }

  function mount() {
    $('side').onclick = ev => {
      const t = ev.target;
      if (FG.active.panelClick && FG.active.panelClick(ev)) return;
      if (t.dataset.mark) toggleMark(t.dataset.mark);
      else if (t.dataset.drop) { state.roots.delete(+t.dataset.drop); refresh(); }
      else if (t.closest('[data-entry]')) setEntry(+t.closest('[data-entry]').dataset.entry);
      else if (t.dataset.sw) { const id = +t.dataset.sw; drawn(id) ? hide(id) : show(id); }
      else if (t.dataset.unhide === 'all') { state.hidden.clear(); refresh(); }
      else if (t.dataset.unhide) restore(+t.dataset.unhide);
      else if (t.dataset.hide) hide(+t.dataset.hide);
      else if (t.dataset.show) show(+t.dataset.show);
      else if (t.dataset.open) toggleOpen(+t.dataset.open);
      else if (t.dataset.root) setRoot(+t.dataset.root, false);
      else if (t.dataset.add) setRoot(+t.dataset.add, true);
      else { const r = t.closest('.row') || t.closest('.exit[data-id]'); if (r) select(+r.dataset.id, null); }
    };
    document.addEventListener('keydown', ev => {
      if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || state.selected == null) return;
      if (ev.key === 'h' || ev.key === 'Backspace' || ev.key === 'Delete') hide(state.selected);
      else if (ev.key === 'e') toggleOpen(state.selected);
    });
  }

  return { mount, render };
})();
