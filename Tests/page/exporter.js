// The exporter in the page: an index store goes in as files, and the snapshot that the page makes opens.
(async () => {
  const expect = (what, ok) => { if (!ok) throw new Error(what); };
  try {
    expect('the page has the exporter', await FGExporter.available());
    const paths = (await (await fetch('index.txt')).text()).trim().split('\n');
    const started = performance.now();
    const picked = [];
    for (let i = 0; i < paths.length; i += 40) {
      picked.push(...await Promise.all(paths.slice(i, i + 40).map(async path => [path.replace(/^index\//, ''), new File([await (await fetch(path)).blob()], path.split('/').pop())])));
    }
    const fetched = performance.now();
    await FGLibrary.addIndex(picked, 'index');
    console.log(`TIME fetch ${Math.round(fetched - started)} ms, export of ${paths.length} files to the open snapshot ${Math.round(performance.now() - fetched)} ms`);
    expect('the snapshot is open: ' + (document.querySelector('#library .err')?.textContent ?? ''), FG.model && FG.model.N.length > 0);
    expect('the library keeps it', (await FGStore.list()).length === 1);
    let refused = '';
    try { await FGExporter.run([['notes.txt', new File(['x'], 'notes.txt')]]); } catch (e) { refused = e.message; }
    expect('a folder with no index store is refused', refused.includes('no index store'));
    console.log(`TIME ${FG.model.N.length} symbols, ${FG.model.entries.length} entry points, ${FG.model.project.name}`);
    console.log('PASS exporter');
  } catch (e) { console.log('FAIL exporter: ' + e.message); }
})();
