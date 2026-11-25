'use strict';
// The library: the snapshots that the browser keeps, and the ones that are open. The head and the base of a diff are chosen here.
const FGLibrary = (() => {
  const { esc } = FG;
  let box, kept = [], rows = [], note = '', warn = false, canExport = false;

  const size = bytes => bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.ceil(bytes / 1e3) + ' KB';
  const idOf = open => open ? FGStore.idOf(open.snapshot) : null;

  const HOW = '<summary>How to make a snapshot</summary>'
    + '<p>A Swift package: <code>swift build</code>, then <code>flowgraph snapshot &lt;project-dir&gt; --out snapshot.json</code></p>'
    + '<p>A C or C++ project: build it with the compiler flag <code>-index-store-path build/idx</code>, '
    + 'then <code>flowgraph snapshot . --sources src --index-store build/idx --out snapshot.json</code></p>'
    + '<p>For a comparison, make a second one of the other commit: <code>flowgraph snapshot &lt;project-dir&gt; --ref main --out base.json</code></p>';
  const COLUMNS = '<div class="lrow lhead"><span>project</span><span>commit</span><span>made</span>'
    + '<span class="n">symbols</span><span class="n">edges</span><span class="n">size</span><span></span></div>';
  const INDEX_TITLE = 'The folder of -index-store-path, or the project folder that holds it and the sources. Nothing leaves this computer.';

  const button = (act, i, text, title, off) =>
    `<button data-act="${act}" data-row="${i}" title="${title}"${off ? ' disabled' : ''}>${text}</button>`;

  function rowHTML(e, i, headId, baseId) {
    const tags = (e.id === headId ? '<i class="tag">open</i>' : '') + (e.id === baseId ? '<i class="tag">base</i>' : '')
      + (e.kept ? '' : ' <span class="dim">not kept</span>');
    const commit = [e.branch, e.commit && e.commit + (e.dirty ? ' + changes' : '')].filter(Boolean).join(' · ');
    const noBase = headId == null || e.id === headId || e.id === baseId;
    return '<div class="lrow">'
      + `<span title="${esc(e.name)}"><b>${esc(e.project || e.name || 'snapshot')}</b>${tags}</span>`
      + `<span class="dim">${esc(commit)}</span>`
      + `<span class="dim">${esc(e.created.slice(0, 16).replace('T', ' '))}</span>`
      + `<span class="n">${e.symbols.toLocaleString()}</span><span class="n">${e.edges.toLocaleString()}</span>`
      + `<span class="n dim">${e.size ? size(e.size) : ''}</span>`
      + `<span class="lact">${button('open', i, 'Open', 'Show this snapshot', e.id === headId)}`
      + button('base', i, 'Base', 'Compare the open snapshot with this one. The two can be of two projects.', noBase)
      + (e.kept ? button('delete', i, 'Delete', 'Take this snapshot out of the library')
        : button('keep', i, 'Keep', 'Put this snapshot in the library of this browser'))
      + '</span></div>';
  }

  function addHTML() {
    const index = !canExport ? ''
      : ` Or <button data-act="index" title="${INDEX_TITLE}">choose the index store of a build</button>, and the page makes the snapshot.`;
    return `<div class="add">Drop snapshot files here, or <button data-act="choose">choose files</button>.${index}</div>`;
  }

  function render() {
    const { head, base } = FG.loaded, headId = idOf(head), baseId = idOf(base);
    rows = kept.map(e => ({ ...e, kept: true }));
    // A snapshot from inside the page or from a link is open with no copy in the library.
    for (const open of [base, head]) {
      if (open && !rows.some(e => e.id === idOf(open))) rows.unshift({ ...FGStore.entry(open.snapshot, open.name), kept: false });
    }
    const total = kept.reduce((sum, e) => sum + e.size, 0);
    box.innerHTML = `<h2>Snapshots${head ? ' <button data-act="close" title="Esc">Back to the views</button>' : ''}</h2>`
      + `<div class="dim">${kept.length ? `This browser keeps ${kept.length}, with ${size(total)}. ` : ''}A snapshot stays on this computer.</div>`
      + (note ? `<div class="${warn ? 'err' : 'note'}">${esc(note)}</div>` : '')
      + (rows.length ? COLUMNS + rows.map((e, i) => rowHTML(e, i, headId, baseId)).join('') : '')
      + addHTML()
      + `<details${rows.length ? '' : ' open'}>${HOW}</details>`;
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

  function snapshotOf(e) {
    const { head, base } = FG.loaded;
    return [head, base].find(open => idOf(open) === e.id)?.snapshot ?? FGStore.get(e.id);
  }

  async function act(name, e) {
    if (name === 'close') return hide();
    if (name === 'choose') return document.getElementById('addfile').click();
    if (name === 'index') return document.getElementById('addindex').click();
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
      try { text = await file.text(); snapshot = JSON.parse(text); FGModel.check(snapshot); }
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

  /** Makes a snapshot from the files of an index store, each with its path below the folder that holds them. */
  async function addIndex(picked, name) {
    await show(`Reading the index of ${name}: ${picked.length.toLocaleString()} files…`);
    try {
      const text = await FGExporter.run(picked);
      await add([{ name: name + ' (index)', text: async () => text }]);
    } catch (e) { show(`${name}: ${e.message}`, true); }
  }

  function mount() {
    box = document.getElementById('library');
    const input = document.getElementById('addfile');
    box.onclick = ev => { const b = ev.target.closest('[data-act]'); if (b) act(b.dataset.act, rows[+b.dataset.row]); };
    input.onchange = () => { const files = [...input.files]; input.value = ''; add(files); };
    const folder = document.getElementById('addindex');
    folder.onchange = () => {
      const files = [...folder.files];
      folder.value = '';
      if (!files.length) return;
      const parts = file => file.webkitRelativePath.split('/');
      addIndex(files.map(f => [parts(f).slice(1).join('/'), f]), parts(files[0])[0]);
    };
    FGExporter.available().then(ok => { canExport = ok; if (ok && box.classList.contains('on')) render(); });
    document.addEventListener('dragover', ev => { ev.preventDefault(); box.classList.add('over'); });
    document.addEventListener('dragleave', () => box.classList.remove('over'));
    document.addEventListener('drop', ev => {
      ev.preventDefault();
      box.classList.remove('over');
      if (ev.dataTransfer.files.length) add([...ev.dataTransfer.files]);
    });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && box.classList.contains('on')) hide(); });
  }

  return { mount, show, hide, add, addIndex };
})();
