'use strict';
// The graph view: the scope as a layered drawing, with Cytoscape.js and the ELK layout.
(() => {
  const { state, esc, short, EDGE_COLOR } = FG;
  let cy = null, runId = 0, drawnGroup = null, limit = Math.max(20, +FG.params.get('limit') || 300), hint = null;

  // The branch of each symbol: the one callee of the root that reaches it, or -1 when several do.
  // With several roots, each root is a branch.
  function branches(shown) {
    const { N, out } = FG.model;
    const roots = [...state.roots];
    // With no root there is no branch: a diff then shows the change with no group.
    if (!roots.length) return new Map();
    const heads = roots.length > 1 ? roots : [...new Set(out[roots[0]].filter(e => !state.off.has(e.kind) && shown.has(e.to) && N[e.to].cls === 'fn' && e.to !== roots[0]).map(e => e.to))];
    const isHead = new Set(heads), owner = new Map();
    for (const h of heads) {
      const seen = new Set([h]), queue = [h];
      while (queue.length) {
        const n = queue.pop();
        for (const e of out[n]) {
          const m = e.to;
          if (state.off.has(e.kind) || seen.has(m) || !shown.has(m) || isHead.has(m) || state.roots.has(m)) continue;
          seen.add(m); queue.push(m);
          owner.set(m, owner.has(m) && owner.get(m) !== h ? -1 : h);
        }
      }
    }
    for (const h of heads) owner.set(h, h);
    return owner;
  }

  function highlight(id) {
    cy.elements().removeClass('faded picked lit');
    const node = id == null ? null : cy.getElementById('n' + id);
    if (!node || node.empty()) return null;
    cy.elements().not(node.closedNeighborhood()).not(':parent').addClass('faded');
    node.addClass('picked');
    node.connectedEdges().addClass('lit');
    return node;
  }

  // What the view says when it has no root to draw from.
  function start() {
    const M = FG.model;
    if (M.merged) return `<b>The two snapshots have no symbol that changed.</b><div class="dim">Set <code>show</code> to <code>all</code>, or find a symbol.</div>`;
    const entries = M.entries.filter(FG.inProduct);
    return `<b>Where do you want to start?</b>`
      + (entries.length ? `<div class="dim">An entry point, with all that it reaches:</div><div class="entries">`
        + entries.slice(0, 24).map(n => `<button data-entry="${n.id}" title="${esc(n.module)}">${esc(short(n))}<span class="dim"> · ${esc(n.module)}</span></button>`).join('')
        + `</div>` + (entries.length > 24 ? `<div class="dim">… and ${entries.length - 24} more in the list <code>entry</code></div>` : '') : '')
      + `<div class="dim">${entries.length ? 'Or find' : 'Find'} a symbol with <kbd>/</kbd>, or see every symbol in the <button data-view="table">Table</button></div>`;
  }

  const view = {
    id: 'graph', title: 'Graph',
    get cy() { return cy; },

    mount(box, viewbar) {
      cy = cytoscape({
        container: box, wheelSensitivity: 0.3, minZoom: 0.03, maxZoom: 3,
        style: [
          { selector: 'node', style: { label: 'data(label)', color: '#d9dce3', 'font-size': 11, 'text-valign': 'center', 'text-halign': 'center', shape: 'round-rectangle', height: 22, 'background-color': '#232730', 'border-width': 1.5, 'border-color': '#555' } },
          { selector: 'node[w]', style: { width: 'data(w)' } },
          { selector: 'node.fn', style: { 'border-color': '#5aa9e6' } },
          { selector: 'node.data', style: { 'border-color': '#e6b35a', shape: 'rectangle' } },
          { selector: 'node.type', style: { 'border-color': '#8fd48f', shape: 'cut-rectangle' } },
          { selector: 'node.ext', style: { 'border-style': 'dashed', opacity: 0.7 } },
          { selector: 'node.open', style: { 'border-style': 'double', 'border-width': 4 } },
          { selector: 'node.d-added', style: { 'background-color': '#1f6a36' } },
          { selector: 'node.d-removed', style: { 'background-color': '#5a2020', 'border-color': '#f08a7a', 'border-width': 2, 'border-style': 'dashed', color: '#f0b0a6' } },
          { selector: 'edge.e-added', style: { 'line-color': '#4fc46a', 'target-arrow-color': '#4fc46a', opacity: 0.9 } },
          { selector: 'edge.e-removed', style: { 'line-color': '#e0604e', 'target-arrow-color': '#e0604e', 'line-style': 'dashed', opacity: 0.9 } },
          { selector: 'node.d-signature', style: { 'background-color': '#8a5a14' } },
          { selector: 'node.d-body', style: { 'background-color': '#77701c' } },
          { selector: 'node.d-affected', style: { 'background-color': '#3d4454' } },
          { selector: 'node.marked', style: { 'border-color': '#e05ad0', 'border-width': 3, color: '#f0a0e6' } },
          { selector: 'node.root', style: { 'background-color': '#4c82e8', color: '#fff', 'border-color': '#fff', 'font-weight': 'bold' } },
          { selector: ':parent', style: { label: 'data(label)', 'text-valign': 'top', 'text-halign': 'center', 'font-size': 10, color: '#8a91a0', 'background-color': '#1b1e25', 'border-color': '#2e333d', 'border-width': 1, shape: 'round-rectangle', padding: 10 } },
          { selector: 'edge', style: { width: 'data(w)', 'curve-style': 'bezier', 'line-color': 'data(color)', 'target-arrow-color': 'data(color)', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, opacity: 0.55 } },
          { selector: 'edge[kind = "dispatch"]', style: { 'line-style': 'dashed' } },
          { selector: '.faded', style: { opacity: 0.08, 'text-opacity': 0.15 } },
          { selector: 'node.picked', style: { 'border-width': 3, 'border-color': '#fff' } },
          { selector: 'edge.lit', style: { opacity: 1, width: 2.5, 'z-index': 9 } },
        ],
      });
      const idOf = ev => ev.target.id()[0] === 'n' ? +ev.target.id().slice(1) : null;
      cy.on('tap', 'node', ev => { const id = idOf(ev); if (id != null) FG.select(id, view); });
      cy.on('tap', ev => { if (ev.target === cy) FG.select(null, view); });
      cy.on('cxttap', 'node', ev => { const id = idOf(ev); if (id != null) FG.hide(id); });
      cy.on('dbltap', 'node', ev => { const id = idOf(ev); if (id != null) FG.setRoot(id, ev.originalEvent.shiftKey); });
      box.addEventListener('contextmenu', ev => ev.preventDefault());
      hint = document.createElement('div'); hint.className = 'ghint'; box.appendChild(hint);
      hint.onclick = ev => { const b = ev.target.closest('[data-entry]'); if (b) FG.setEntry(+b.dataset.entry); else if (ev.target.dataset.view) FG.activate(ev.target.dataset.view); };
      view.bar(viewbar);
    },

    // The controls that only this view has.
    bar(viewbar) {
      viewbar.innerHTML = `<label>limit <input type="number" min="20" step="100" value="${limit}" style="width:70px"></label><button>Fit</button>`;
      viewbar.querySelector('input').onchange = ev => { limit = Math.max(20, +ev.target.value || 300); FG.refresh(); };
      viewbar.querySelector('button').onclick = () => cy.fit(undefined, 30);
    },

    reset() { cy.elements().remove(); drawnGroup = null; },
    has: id => cy != null && cy.getElementById('n' + id).nonempty(),

    select(id, reveal) {
      const node = highlight(id);
      if (node && reveal) cy.animate({ center: { eles: node } }, { duration: 200 });
    },

    update(scope) {
      const { N, E, out, inc, files, edgeKinds } = FG.model;
      cy.resize();
      hint.classList.toggle('on', !scope.order.length);
      if (!scope.order.length) { cy.elements().remove(); hint.innerHTML = start(); FG.status(`${N.length.toLocaleString()} symbols, ${E.length.toLocaleString()} edges`); return; }
      const shown = new Set(scope.order.slice(0, limit));
      const group = state.group, groups = new Map(), els = [];
      const owner = group === 'branch' ? branches(shown) : null;
      const branchOf = n => { const o = owner.get(n.id); return o == null ? null : o < 0 ? 'shared by several branches' : N[o].name; };
      const productOf = n => { const p = FG.productsOf(n); return p.length === 1 ? p[0] : p.length > 3 ? `shared by ${p.length} products` : p.length ? 'shared by ' + p.join(', ') : 'in no product'; };
      const groupOf = n => group === 'branch' ? branchOf(n) : group === 'product' ? productOf(n) : group === 'package' ? (n.pkg || 'other modules')
        : group === 'file' ? (n.file >= 0 ? files[n.file] : n.module || 'other modules')
        : group === 'module' ? (n.module || 'other modules')
        : group === 'type' ? (n.parent >= 0 ? N[n.parent].name : null) : null;
      for (const id of shown) {
        const n = N[id], g = groupOf(n);
        if (g != null && !groups.has(g)) { groups.set(g, 'g' + groups.size); els.push({ data: { id: groups.get(g), label: g } }); }
        const label = short(group === 'type' && n.parent >= 0 ? n.name.slice(N[n.parent].name.length + 1) : n.name);
        els.push({ data: { id: 'n' + id, label, w: Math.max(40, label.length * 6.4 + 16), parent: g != null ? groups.get(g) : undefined },
          classes: [n.cls, n.ext ? 'ext' : '', state.roots.has(id) ? 'root' : '', state.open.has(id) ? 'open' : '', FG.isMarked(id) ? 'marked' : '', n.diff ? 'd-' + n.diff : ''].join(' ') });
      }
      let edgeCount = 0;
      const merged = new Map();
      for (const id of shown) for (const e of out[id]) {
        if (!shown.has(e.to) || state.off.has(e.kind) || e.to === e.from) continue;
        const key = e.from + '>' + e.to, old = merged.get(key);
        // Two nodes get one line: a call wins over a read of the same symbol.
        // The line is added or removed only when each edge that it stands for is.
        const diff = old && old.diff !== (e.diff || '') ? '' : e.diff || '';
        if (!old || edgeKinds.indexOf(e.kind) < edgeKinds.indexOf(old.kind)) merged.set(key, { ...e, count: e.count + (old ? old.count : 0), diff });
        else { old.count += e.count; old.diff = diff; }
      }
      for (const [key, e] of merged) {
        els.push({ data: { id: 'e' + key, source: 'n' + e.from, target: 'n' + e.to, kind: e.kind, color: EDGE_COLOR[e.kind], w: Math.min(4, 1 + Math.log2(e.count)) }, classes: e.diff ? 'e-' + e.diff : '' });
        edgeCount++;
      }
      // Only the difference changes: what stays keeps its place, and the layout moves it to the new place.
      const fresh = drawnGroup !== group || cy.nodes().empty();
      drawnGroup = group;
      if (fresh) { cy.elements().remove(); cy.add(els); }
      else {
        const want = new Map(els.map(el => [el.data.id, el]));
        cy.batch(() => {
          cy.elements().filter(el => !want.has(el.id())).remove();
          const added = els.filter(el => cy.getElementById(el.data.id).empty());
          // Groups first, then nodes, then edges, because each needs the one before.
          const rank = el => el.data.source ? 2 : el.data.id[0] === 'g' ? 0 : 1;
          added.sort((a, b) => rank(a) - rank(b));
          for (const el of added) {
            if (rank(el) === 1) {
              // A new symbol starts at a neighbour that is drawn already, and moves out from there.
              const id = +el.data.id.slice(1);
              const near = [...out[id].map(e => e.to), ...inc[id].map(e => e.from)].map(m => cy.getElementById('n' + m)).find(c => c.nonempty() && !c.isParent());
              const from = near || cy.nodes('.root').first();
              if (from.nonempty()) el.position = { ...from.position() };
            }
            cy.add(el);
          }
          for (const el of els) if (el.data.source || el.data.id[0] === 'n') cy.getElementById(el.data.id).classes(el.classes);
        });
      }
      const more = scope.order.length - shown.size;
      const text = (state.roots.size ? '' : 'no root: what changed, and what is next to it · ') + `${shown.size} symbols, ${edgeCount} edges` + (more ? ` — ${more} more are reachable: raise the limit or lower the depth` : '');
      FG.status(text + ' · laying out…', more > 0);
      const mine = ++runId, t0 = performance.now();
      const layout = cy.layout({
        name: 'elk', fit: true, padding: 30, nodeDimensionsIncludeLabels: false,
        animate: !fresh && shown.size <= 600 && FG.params.get('animate') !== '0', animationDuration: 350, animationEasing: 'ease-in-out',
        elk: { algorithm: 'layered', 'elk.direction': 'RIGHT', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
          'elk.layered.spacing.nodeNodeBetweenLayers': 60, 'elk.spacing.nodeNode': 10, 'elk.layered.spacing.edgeNodeBetweenLayers': 12,
          // ELK refuses to skip the crossing step when groups are laid out together, so only a graph with no groups skips it.
          'elk.layered.crossingMinimization.strategy': shown.size > 400 && !groups.size ? 'NONE' : 'LAYER_SWEEP',
          'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.edgeRouting': 'POLYLINE', 'elk.padding': '[top=22,left=10,bottom=10,right=10]' },
      });
      let done = false;
      layout.one('layoutstop', () => { if (mine === runId) { done = true; FG.status(`${text} · ${Math.round(performance.now() - t0)} ms`, more > 0); highlight(state.selected); } });
      // ELK fails on a graph that is too large: say so, and do not leave an empty page.
      // The page has one handler for all layouts, so the failure of an older layout, which a newer one cut short, also comes here.
      // A layout that ended did not fail, and a layout that ends later writes its own status over this one.
      const failed = () => { if (mine === runId && !done) FG.status(`${shown.size} symbols are too many to lay out: lower the limit or the depth`, true); };
      window.onunhandledrejection = failed;
      try { layout.run(); } catch (e) { failed(); }
    },
  };
  FG.registerView(view);
})();
