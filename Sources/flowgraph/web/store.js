'use strict';
// The snapshots that this browser keeps, in IndexedDB. The text of a snapshot is apart from its entry, so the list reads no snapshot.
const FGStore = (() => {
  let opened = null;
  const done = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });

  function database() {
    opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('flowgraph', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('entries', { keyPath: 'id' }); request.result.createObjectStore('texts'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return opened;
  }
  async function within(mode, work) {
    const tx = (await database()).transaction(['entries', 'texts'], mode);
    const result = work(tx.objectStore('entries'), tx.objectStore('texts'));
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
    return result;
  }

  /** Two exports of one commit are two snapshots, so the time of the export is part of the identity. */
  const idOf = s => [s.project.name, s.project.commit, s.project.created].join('|');
  /** @returns {{id, name, project, commit, branch, dirty, created, added, size, symbols, edges}} */
  function entry(snapshot, name, size = 0) {
    const p = snapshot.project;
    return { id: idOf(snapshot), name: name || '', project: p.name || '', commit: p.commit || '', branch: p.branch || '', dirty: !!p.dirty, created: p.created || '',
      added: Date.now(), size, symbols: snapshot.symbols.length, edges: snapshot.edges.length };
  }

  return {
    idOf, entry,
    /** The entries, the newest first. */
    list: async () => (await within('readonly', entries => done(entries.getAll()))).sort((a, b) => b.added - a.added),
    /** The snapshot of one entry, or undefined. */
    get: async id => { const text = await within('readonly', (_, texts) => done(texts.get(id))); return text && JSON.parse(text); },
    /** Keeps a snapshot, in place of an older copy of the same one. `text` is its JSON, when the caller has it. */
    put(snapshot, name, text = JSON.stringify(snapshot)) {
      const e = entry(snapshot, name, text.length);
      return within('readwrite', (entries, texts) => { entries.put(e); texts.put(text, e.id); return e; });
    },
    remove: id => within('readwrite', (entries, texts) => { entries.delete(id); texts.delete(id); }),
  };
})();
