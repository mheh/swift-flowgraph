'use strict';
// The worker of exporter.js: it runs the exporter on the files that it gets, and answers with the text of the snapshot or with the error.
importScripts('wasi.js');

onmessage = async ev => {
  try {
    const module = await WebAssembly.compile(await (await fetch('exporter.wasm')).arrayBuffer());
    const result = FGWasi.run(module, ['flowgraph', 'snapshot', '/project', '--index-store', '/index', '--out', '/snapshot.json'], ev.data);
    const bytes = result.written.get('/snapshot.json');
    if (result.exit || !bytes) throw new Error(result.log.trim().split('\n').pop().replace(/^flowgraph: /, '') || 'the exporter wrote no snapshot');
    postMessage({ text: new TextDecoder().decode(bytes) });
  } catch (e) { postMessage({ error: e.message }); }
};
