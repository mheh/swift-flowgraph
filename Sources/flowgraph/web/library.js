'use strict';
// The library: the snapshots that the browser keeps, and the ones that are open. It is the start of the page, and where the head and the base of a diff are chosen.
const FGLibrary = (() => {
  const { esc } = FG;
  let box, kept = [], rows = [], note = '', warn = false;

  const size = bytes => bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.ceil(bytes / 1e3) + ' KB';
  const idOf = open => open ? FGStore.idOf(open.snapshot) : null;

  function render() {
    const { head, base } = FG.loaded, headId = idOf(head), baseId = idOf(base);
    rows = kept.map(e => ({ ...e, kept: true }));
    // A snapshot from inside the page or from a link is open with no copy in the library.
    for (const open of [base, head]) if (open && !rows.some(e => e.id === idOf(open))) rows.unshift({ ...FGStore.entry(open.snapshot, open.name), kept: false });
    const button = (act, i, text, title, off) => `<button data-act="${act}" data-row="${i}" title="${title}"${off ? ' disabled' : ''}>${text}</button>`;
    const row = (e, i) => `<div class="lrow">`
      + `<span title="${esc(e.name)}"><b>${esc(e.project || e.name || 'snapshot')}</b>${e.id === headId ? '<i class="tag">open</i>' : ''}${e.id === baseId ? '<i class="tag">base</i>' : ''}${e.kept ? '' : ' <span class="dim">not kept</span>'}</span>`
      + `<span class="dim">${esc([e.branch, e.commit && e.commit + (e.dirty ? ' + changes' : '')].filter(Boolean).join(' · '))}</span>`
      + `<span class="dim">${esc(e.created.slice(0, 16).replace('T', ' '))}</span>`
      + `<span class="n">${e.symbols.toLocaleString()}</span><span class="n">${e.edges.toLocaleString()}</span><span class="n dim">${e.size ? size(e.size) : ''}</span>`
      + `<span class="lact">${button('open', i, 'Open', 'Show this snapshot', e.id === headId)}`
      + button('base', i, 'Base', 'Compare the open snapshot with this one. The two can be of two projects.', !head || e.id === headId || e.id === baseId)
      + (e.kept ? button('delete', i, 'Delete', 'Take this snapshot out of the library') : button('keep', i, 'Keep', 'Put this snapshot in the library of this browser')) + `</span></div>`;
    const total = kept.reduce((sum, e) => sum + e.size, 0);
    box.innerHTML = `<h2>Snapshots${head ? ' <button data-act="close" title="Esc">Back to the views</button>' : ''}</h2>`
      + `<div class="dim">${kept.length ? `This browser keeps ${kept.length}, with ${size(total)}. ` : ''}A snapshot stays on this computer.</div>`
      + (note ? `<div class="${warn ? 'err' : 'note'}">${esc(note)}</div>` : '')
      + (rows.length ? `<div class="lrow lhead"><span>project</span><span>commit</span><span>made</span><span class="n">symbols</span><span class="n">edges</span><span class="n">size</span><span></span></div>` + rows.map(row).join('') : '')
      + `<div class="add">Drop snapshot files here, or <button data-act="choose">choose files</button>.</div>`
      + `<details${rows.length ? '' : ' open'}><summary>How to make a snapshot</summary>`
      + `<p>A Swift package: <code>swift build</code>, then <code>flowgraph snapshot &lt;project-dir&gt; --out snapshot.json</code></p>`
      + `<p>A C or C++ project: build it with the compiler flag <code>-index-store-path build/idx</code>, then <code>flowgraph snapshot . --sources src --index-store build/idx --out snapshot.json</code></p>`
      + `<p>For a comparison, make a second one of the other commit: <code>flowgraph snapshot &lt;project-dir&gt; --ref main --out base.json</code></p></details>`;
  }

  async function reload() {
    try { kept = await FGStore.list(); }
    catch (e) { kept = []; note ||= `This browser gives the page no storage, so a snapshot opens but is not kept. (${e.message})`; }
    render();
  }

  function show(text = '', isWarning = false) {
    note = text; warn = isWarning;
    box.classList.add('on');
    document.body.classList.toggle('empty', !FG.model);
    render();
    return reload();
  }
  function hide() {
    if (!FG.model) return;
    box.classList.remove('on');
    document.body.classList.remove('empty');
  }

  const snapshotOf = e => { const { head, base } = FG.loaded; return [head, base].find(open => idOf(open) === e.id)?.snapshot ?? FGStore.get(e.id); };

  async function act(name, e) {
    if (name === 'close') return hide();
    if (name === 'choose') return document.getElementById('addfile').click();
    try {
      if (name === 'delete') await FGStore.remove(e.id);
      else {
        const snapshot = await snapshotOf(e);
        if (!snapshot) throw new Error('the library has no text for this snapshot');
        if (name === 'open') return FG.load(snapshot, e.name);
        if (name === 'base') return FG.setBase(snapshot, e.name);
        await FGStore.put(snapshot, e.name);
      }
      await show();
    } catch (error) { show(`${e.project || e.name}: ${error.message}`, true); }
  }

  /** Reads snapshot files into the library. One file opens at once when no snapshot is open. */
  async function add(files) {
    const read = [], errors = [];
    for (const file of files) {
      let text, snapshot;
      try { text = await file.text(); snapshot = JSON.parse(text); FG.check(snapshot); }
      catch (e) { errors.push(`${file.name}: ${e.message}`); continue; }
      read.push({ snapshot, name: file.name });
      try { await FGStore.put(snapshot, file.name, text); }
      catch (e) { errors.push(`${file.name} is not kept: ${e.message}`); }
    }
    if (read.length === 1 && !FG.model) {
      FG.load(read[0].snapshot, read[0].name);
      if (errors.length) FG.status(errors.join(' · '), true);
    } else await show(errors.join(' · '), true);
  }

  function mount() {
    box = document.getElementById('library');
    const input = document.getElementById('addfile');
    box.onclick = ev => { const b = ev.target.closest('[data-act]'); if (b) act(b.dataset.act, rows[+b.dataset.row]); };
    input.onchange = () => { const files = [...input.files]; input.value = ''; add(files); };
    document.addEventListener('dragover', ev => { ev.preventDefault(); box.classList.add('over'); });
    document.addEventListener('dragleave', () => box.classList.remove('over'));
    document.addEventListener('drop', ev => { ev.preventDefault(); box.classList.remove('over'); if (ev.dataTransfer.files.length) add([...ev.dataTransfer.files]); });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && box.classList.contains('on')) hide(); });
  }

  return { mount, show, hide, add };
})();
