// Prints how long the page takes for each step on the snapshot head.json, and for the diff with base.json. It measures, and it fails only on an error.
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  const $ = id => document.getElementById(id);
  const settled = async () => { const t = performance.now(); while (/laying out/.test($('status').textContent) && performance.now() - t < 30000) await wait(20); };
  const timed = async (name, work) => { const t = performance.now(); await work(); console.log(`TIME ${name}: ${Math.round(performance.now() - t)} ms`); };
  try {
    let text, snapshot;
    await timed('fetch', async () => { text = await (await fetch('head.json')).text(); });
    await timed('parse', () => { snapshot = JSON.parse(text); });
    await timed('load', async () => { FG.load(snapshot, 'head.json'); await frame(); });
    const { N, out, entries } = FG.model;
    console.log(`TIME size: ${N.length} symbols, ${FG.model.E.length} edges, ${(text.length / 1e6).toFixed(1)} MB`);
    const entry = entries[0] || N.find(n => n.cls === 'fn' && !n.ext && out[n.id].length > 3);
    await timed('entry point, the scope', async () => { FG.setEntry(entry.id); await frame(); });
    await timed('entry point, the layout', settled);
    console.log(`TIME scope: ${FG.scope.order.length} symbols reached`);
    const next = N.find(n => n.cls === 'fn' && !n.ext && n.id !== entry.id && out[n.id].filter(e => e.kind === 'calls').length > 5);
    await timed('change of the root', async () => { FG.setRoot(next.id, false); await frame(); await settled(); });
    await timed('select', async () => { FG.select(next.id, null); await frame(); });
    FG.state.roots.clear();
    await timed('table, first render', async () => { FG.activate('table'); await frame(); });
    const scroll = document.querySelector('.tbl .scroll');
    const times = [];
    for (let i = 1; i <= 40; i++) { const t = performance.now(); scroll.scrollTop = i * scroll.scrollHeight / 41; await frame(); times.push(performance.now() - t); }
    times.sort((a, b) => a - b);
    console.log(`TIME table, one scroll step: median ${Math.round(times[20])} ms, worst ${Math.round(times[39])} ms, ${document.querySelectorAll('.tbl .tr').length} rows drawn`);
    await timed('trace', async () => { FG.setRoot(next.id, false); FG.activate('trace'); await frame(); });
    const base = await (await fetch('base.json')).json();
    await timed('base of a diff', async () => { FG.setBase(base, 'base.json'); await frame(); await settled(); });
    console.log('PASS speed');
  } catch (e) { console.log('FAIL speed: ' + e.message); }
})();
