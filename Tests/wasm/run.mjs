// Runs the exporter that Wasm/build.sh makes, with the WASI of the page, on an index store of the disk.
// usage: node Tests/wasm/run.mjs <exporter.wasm> <index-store> <out.json> [arguments of flowgraph snapshot ...]
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [program, store, out, ...more] = process.argv.slice(2);
const web = join(dirname(fileURLToPath(import.meta.url)), '../../Sources/flowgraph/web');
const FGWasi = new Function(readFileSync(join(web, 'wasi.js'), 'utf8') + '; return FGWasi;')();

const files = readdirSync(store, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
  .map(e => {
    const path = join(e.parentPath, e.name);
    return ['/index' + path.slice(store.length), Object.assign(new Uint8Array(readFileSync(path)), { lastModified: statSync(path).mtimeMs })];
  });
const started = performance.now();
const result = FGWasi.run(new WebAssembly.Module(readFileSync(program)), ['flowgraph', 'snapshot', '/project', '--index-store', '/index', '--out', '/snapshot.json', ...more], [...files, ['/project/.keep', new Uint8Array(0)]]);
process.stderr.write(result.log);
console.error(`${files.length} files, ${Math.round(performance.now() - started)} ms, exit ${result.exit}`);
if (result.written.has('/snapshot.json')) writeFileSync(out, result.written.get('/snapshot.json'));
process.exit(result.exit);
