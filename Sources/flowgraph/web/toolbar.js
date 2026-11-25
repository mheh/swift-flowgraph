'use strict';
// The toolbar: the search, the controls of the scope and of the filters, the marks, and the controls of a diff.
const FGToolbar = (() => {
  const { state, esc, short, EDGE_COLOR, row, refresh, setRoot, setEntry, setProduct, activate, chooseBase, swapDiff, setBase, setSide, toggleMark } = FG;
  const $ = id => document.getElementById(id);

  let hitIndex = 0, hitList = [];
  function search(q) {
    q = q.trim().toLowerCase();
    if (!q || !FG.model) return [];
    const scored = [];
    for (const n of FG.model.N) {
      const name = n.name.toLowerCase(), at = name.indexOf(q);
      if (at < 0) continue;
      const base = name.split('(')[0];
      const rank = base === q ? 0 : base.endsWith('.' + q) ? 1 : at === 0 ? 2 : name[at - 1] === '.' ? 3 : 4;
      scored.push([rank * 1000 + (n.ext ? 500 : 0) + name.length, n]);
    }
    return scored.sort((a, b) => a[0] - b[0]).slice(0, 40).map(s => s[1]);
  }
  function showHits() {
    hitList = search($('search').value);
    hitIndex = 0;
    $('hits').innerHTML = hitList.map((n, i) => row(n).replace('class="row"', `class="row${i ? '' : ' on'}"`)).join('');
    $('hits').style.display = hitList.length ? 'block' : 'none';
  }
  function closeSearch() { $('hits').style.display = 'none'; $('search').value = ''; }

  const option = (value, text, now) => `<option value="${value}"${value === now ? ' selected' : ''}>${text}</option>`;
  const choice = (name, title, label, options, now) =>
    ` <label title="${title}">${label} <select data-diff="${name}">${options.map(([value, text]) => option(value, text, now)).join('')}</select></label>`;

  function markName(key) {
    const name = key.slice(2);
    return key[0] === 'm' ? 'module ' + name : (FG.model.N.find(n => n.usr === name) || { name }).name;
  }
  function syncMarks() {
    const title = 'Mark what you plan to replace: select a symbol, then Mark in the panel. Each view shows where it is used.';
    const chips = state.marks.map(k => `<span class="chip mark">▣ ${esc(short(markName(k)))} <b data-unmark="${esc(k)}">×</b></span>`).join('');
    $('marks').innerHTML = `<span class="dim" title="${title}">replace:</span> ` + (chips || '<span class="dim">nothing marked</span>');
  }
  function syncDiff() {
    const F = FG.diff;
    $('diffbutton').textContent = F ? 'Changes' : 'Diff…';
    if (!F) { $('diffinfo').innerHTML = ''; return; }
    const p = F.base.project;
    $('diffinfo').innerHTML = `<span class="chip" title="The base of the diff. The snapshot of the page is the head.">`
      + `base: ${esc([F.base.name, p.branch, p.commit].filter(Boolean).join(' · '))}`
      + ` <b data-diff="swap" title="Swap the base and the head">⇄</b> <b data-diff="off" title="End the diff">×</b></span>`
      + choice('show', 'Which symbols the views hold', 'show', [['all', 'all'], ['changed', 'changed + affected'], ['only', 'changed only']], state.diffShow)
      + choice('side', 'Which snapshot the views show: both as one, the head alone (the new code), or the base alone (the old code)', 'side',
        [['both', 'both'], ['head', 'head only'], ['base', 'base only']], state.side);
  }

  /** Sets each control to the state. */
  function sync() {
    for (const id of ['up', 'down']) {
      const known = [...$(id).options].some(o => +o.value === state[id]);
      if (!known) $(id).insertAdjacentHTML('beforeend', `<option value="${state[id]}">${state[id]}</option>`);
      $(id).value = state[id];
    }
    $('group').value = state.group; $('product').value = state.product;
    for (const id of ['data', 'types', 'ext', 'sys']) $(id).checked = state[id];
    for (const box of $('kinds').querySelectorAll('input')) box.checked = !state.off.has(box.dataset.kind);
    syncMarks(); syncDiff();
  }

  /** A snapshot arrived: the controls that depend on it are made again. */
  function loaded() {
    const M = FG.model, p = M.project, present = list => list.filter(Boolean);
    $('title').textContent = p.name || 'flowgraph';
    document.title = (p.name || 'snapshot') + ' — flowgraph';
    $('source').textContent = present([
      FG.loaded.head.name, p.branch, p.commit && p.commit + (p.dirty ? ' + changes' : ''),
      p.staleFiles ? `index older than ${p.staleFiles} source files` : '',
    ]).join(' · ');
    $('source').title = present([
      p.created && 'snapshot made ' + p.created, p.indexed && 'index written ' + p.indexed,
      p.unindexedFiles && p.unindexedFiles + ' source files are not in the index: the build did not compile them',
    ]).join('\n');
    $('kinds').innerHTML = M.edgeKinds
      .map(k => `<label><input type="checkbox" data-kind="${k}" checked><span style="color:${EDGE_COLOR[k]}">${k}</span></label>`).join(' ');
    $('product').innerHTML = '<option value="">all</option>'
      + M.products.map(q => `<option value="${esc(q.name)}">${esc(q.name)} · ${esc(q.type)}</option>`).join('');
    $('productbox').style.display = M.products.length ? '' : 'none';
    $('entry').innerHTML = '<option value="">…</option>'
      + M.entries.map(n => `<option value="${n.id}">${esc(n.module)} · ${esc(short(n))}</option>`).join('');
    $('entrybox').style.display = M.entries.length ? '' : 'none';
    $('extbox').style.display = M.N.some(n => n.ext && !n.sys) ? '' : 'none';
    $('sysbox').style.display = M.N.some(n => n.sys) ? '' : 'none';
  }

  function mountScope() {
    for (const id of ['up', 'down']) {
      $(id).innerHTML = [0, 1, 2, 3, 4, 6, 8, -1].map(d => `<option value="${d}">${d < 0 ? 'max' : d}</option>`).join('');
      $(id).onchange = () => { state[id] = +$(id).value; refresh(); };
    }
    $('group').onchange = () => { state.group = $('group').value; refresh(); };
    for (const id of ['data', 'types', 'ext', 'sys']) $(id).onchange = () => { state[id] = $(id).checked; refresh(); };
    $('kinds').onchange = ev => { const k = ev.target.dataset.kind; ev.target.checked ? state.off.delete(k) : state.off.add(k); refresh(); };
    $('product').onchange = () => setProduct($('product').value);
    $('entry').onchange = () => { if ($('entry').value) setEntry(+$('entry').value); };
  }

  function mountSearch() {
    $('search').oninput = showHits;
    $('search').onkeydown = ev => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        hitIndex = Math.max(0, Math.min(hitList.length - 1, hitIndex + (ev.key === 'ArrowDown' ? 1 : -1)));
        [...$('hits').children].forEach((c, i) => c.classList.toggle('on', i === hitIndex));
        $('hits').children[hitIndex]?.scrollIntoView({ block: 'nearest' });
        ev.preventDefault();
      } else if (ev.key === 'Enter' && hitList[hitIndex]) setRoot(hitList[hitIndex].id, ev.shiftKey);
      else if (ev.key === 'Escape') { $('hits').style.display = 'none'; $('search').blur(); }
    };
    $('hits').onmousedown = ev => { const r = ev.target.closest('.row'); if (r) setRoot(+r.dataset.id, ev.shiftKey); };
    document.addEventListener('keydown', ev => {
      if (ev.key !== '/' || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      $('search').focus(); $('search').select(); ev.preventDefault();
    });
    document.addEventListener('mousedown', ev => { if (!ev.target.closest('#searchbox')) $('hits').style.display = 'none'; });
  }

  function mountDiff() {
    $('diffbutton').onclick = () => { if (FG.diff) activate('diff'); else chooseBase(); };
    $('librarybutton').onclick = () => FGLibrary.show();
    $('diffinfo').onclick = ev => { const d = ev.target.dataset.diff; if (d === 'swap') swapDiff(); else if (d === 'off') setBase(null, ''); };
    $('diffinfo').onchange = ev => {
      const d = ev.target.dataset.diff;
      if (d === 'side') setSide(ev.target.value);
      else if (d === 'show') { state.diffShow = ev.target.value; refresh(); }
    };
    $('marks').onclick = ev => { if (ev.target.dataset.unmark) toggleMark(ev.target.dataset.unmark); };
  }

  function mount() { mountScope(); mountSearch(); mountDiff(); }

  return { mount, loaded, sync, closeSearch };
})();
