'use strict';
// The side panel: the roots, what is hidden, and the selected symbol with who uses it and what its body holds.
const FGPanel = (() => {
  const { state, esc, short, EDGE_COLOR, row: rowHTML, markKey, body, inProduct, where, toggleMark, refresh, setEntry, hide, show, restore, toggleOpen, setRoot, select } = FG;
  const $ = id => document.getElementById(id);

  // A row of the panel with a switch: − takes a shown symbol out, + shows one that is not shown.
  const drawn = id => FG.active && FG.active.has ? FG.active.has(id) : FG.scope.dist.has(id);
  const panelRow = (n, extra) => rowHTML(n, extra)
    .replace('<span class="dot', `<b class="sw" data-sw="${n.id}" title="${drawn(n.id) ? 'Hide' : 'Show'}">${drawn(n.id) ? '−' : '+'}</b><span class="dot`)
    .replace('class="row"', `class="row${drawn(n.id) ? '' : ' absent'}"`);
  function list(title, edges, end) {
    if (!edges.length) return '';
    const { N, files } = FG.model, byKind = {};
    for (const e of edges) (byKind[e.kind] = byKind[e.kind] || []).push(e);
    let html = '';
    for (const kind of FG.model.edgeKinds) {
      const es = byKind[kind];
      if (!es) continue;
      es.sort((a, b) => end === 'to' ? a.line - b.line : N[a[end]].name.localeCompare(N[b[end]].name));
      html += `<h3><span style="color:${EDGE_COLOR[kind]}">${kind}</span> ${title} · ${es.length}</h3>`;
      html += es.slice(0, 400).map(e => {
        const site = N[e.from];
        return panelRow(N[e[end]], (e.diff === 'added' ? '<span class="dst d-added">+</span> ' : e.diff === 'removed' ? '<span class="dst d-removed">−</span> ' : '') + esc(`${site.file >= 0 ? files[site.file].split('/').pop() : ''}:${e.line}${e.count > 1 ? ' ×' + e.count : ''}`));
      }).join('');
      if (es.length > 400) html += `<div class="dim">… and ${es.length - 400} more</div>`;
    }
    return html;
  }
  function render() {
    if (!FG.model) { $('side').innerHTML = ''; return; }
    const { N, out, inc, kids } = FG.model;
    const mine = FG.active && FG.active.panel ? FG.active.panel() : '';
    const chips = [...state.roots].map(r => `<span class="chip">${esc(short(N[r]))} <b data-drop="${r}">×</b></span>`).join('');
    let html = `<h3>Roots</h3>${chips || '<span class="dim">none</span>'}`;
    if (state.hidden.size) html += `<h3>Hidden · ${state.hidden.size} <button data-unhide="all">Show all</button></h3>`
      + [...state.hidden].map(h => `<span class="chip off">${esc(short(N[h]))} <b data-unhide="${h}">×</b></span>`).join('');
    html += mine;
    const id = state.selected;
    if (id == null) {
      html += `<p class="dim">Click a symbol to see who calls and uses it. Double-click it to make it the root. Shift adds a root.<br>Right-click or <b>h</b> hides a symbol. <b>e</b> shows all its neighbours.</p>`;
      if (!state.roots.size) {
        // With no root, offer the entry points, and the functions that nothing in the project calls.
        const tops = N.filter(n => n.cls === 'fn' && !n.ext && inProduct(n) && !inc[n.id].some(e => e.kind === 'calls' || e.kind === 'refs' || e.kind === 'dispatch') && out[n.id].length)
          .sort((a, b) => out[b.id].length - out[a.id].length).slice(0, 60);
        const entries = FG.model.entries.filter(inProduct);
        if (state.product) html += `<p class="dim">The product ${esc(state.product)} has ${N.filter(inProduct).length} symbols${entries.length ? '' : ' and no marked entry point: pick a function below, or find one'}.</p>`;
        if (entries.length) html += `<h3>Entry points · ${entries.length}</h3>` + entries.map(n => rowHTML(n, esc(n.module)).replace('data-id', 'data-entry')).join('');
        html += `<h3>Functions with no caller · largest first</h3>` + tops.map(n => rowHTML(n, esc(n.module) + ' · ' + out[n.id].length + ' edges')).join('');
      }
    } else {
      const n = N[id];
      html += `<h3>${esc(n.kind)}${n.diff ? ` · <span class="dst d-${n.diff}">${FGDiff.LABEL[n.diff]}</span>` : ''}</h3><h2>${esc(n.name)}</h2><div class="dim">${esc(where(n))}</div>`;
      if (FG.model.decl[id]) html += `<pre>${esc(FG.model.decl[id])}</pre>`;
      if (FG.model.doc[id]) html += `<div>${esc(FG.model.doc[id])}</div>`;
      html += `<div class="actions"><button data-root="${id}">Make root</button><button data-add="${id}">Add as root</button>`
        + (drawn(id) ? `<button data-open="${id}">${state.open.has(id) ? 'Collapse neighbours' : 'Expand neighbours'}</button>` + (state.roots.has(id) ? '' : `<button data-hide="${id}">Hide</button>`)
          : `<button data-show="${id}">Show</button>`)
        + `<button data-mark="${esc(markKey(n))}">${state.marks.includes(markKey(n)) ? 'Unmark' : '▣ Mark for replacement'}</button>`
        + (n.module ? `<button data-mark="m:${esc(n.module)}">${state.marks.includes('m:' + n.module) ? 'Unmark' : '▣ Mark'} module ${esc(n.module)}</button>` : '') + `</div>`;
      if (n.label) html += `<div class="dim">An entry point: the project hands it to <code>${esc(n.label)}</code></div>`;
      const b = body(id);
      if (b) html += `<div class="dim">${[b.async && 'async', b.throws && 'throws'].filter(Boolean).join(' · ')}</div>`;
      if (kids[id].length) html += `<h3>Members · ${kids[id].length}</h3>` + kids[id].slice(0, 200).map(k => panelRow(N[k], `${inc[k].length} in · ${out[k].length} out`)).join('');
      html += list('— used by', inc[id], 'from') + list('— in its body, in source order', out[id], 'to');
    }
    $('side').innerHTML = html;
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
