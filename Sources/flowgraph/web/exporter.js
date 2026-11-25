'use strict';
// Makes a snapshot in the page from the index store of a build, with the exporter as a WebAssembly program. Only a hosted page that has the program offers it.
const FGExporter = (() => {
  const SOURCE = /\.(swift|c|h|m|mm|cc|cpp|cxx|hpp|hh)$/;
  let has = null;
  const available = () => has ??= fetch('exporter.wasm', { method: 'HEAD' }).then(r => r.ok, () => false);

  /** Where the program finds each file: the index store, and the sources when the folder holds them too. */
  function place(picked) {
    const inStore = picked.find(([path]) => /(^|\/)v5\/(units|records)\//.test(path));
    if (!inStore) throw new Error('the folder holds no index store: there is no v5/units below it');
    const store = inStore[0].replace(/v5\/(units|records)\/.*$/, '');
    const files = [['/project/.keep', new Uint8Array(0)]];
    for (const [path, file] of picked) {
      if (path.startsWith(store + 'v5/')) files.push(['/index/' + path.slice(store.length), file]);
      else if (SOURCE.test(path)) files.push(['/project/' + path, file]);
    }
    return files;
  }

  /**
   * @param {[string, File][]} picked Each file of the folder, with its path below the folder.
   * @returns {Promise<string>} The text of the snapshot.
   */
  function run(picked) {
    const files = place(picked);
    return new Promise((resolve, reject) => {
      const worker = new Worker('exporter-worker.js');
      const end = (error, text) => { worker.terminate(); error ? reject(new Error(error)) : resolve(text); };
      worker.onmessage = ev => end(ev.data.error, ev.data.text);
      worker.onerror = ev => end(ev.message || 'the exporter did not start');
      worker.postMessage(files);
    });
  }

  return { available, run };
})();
