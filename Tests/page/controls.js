// The controls that every view shares: the search, the side panel, the depth, the marks, the tabs, and the controls of a diff.
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const expect = (what, ok) => { if (!ok) throw new Error(what); };
  const get = async name => (await fetch(name)).json();
  const $ = id => document.getElementById(id);
  const key = (target, k) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  try {
    FG.load(await get('head.json'), 'head.json');
    await wait(300);
    expect('the toolbar names the project and the file', $('title').textContent === FG.model.project.name && /head\.json/.test($('source').textContent));
    expect('each kind of edge has a check box', $('kinds').querySelectorAll('input').length === FG.model.edgeKinds.length);

    const calls = n => n.cls === 'fn' && !n.ext && FG.model.out[n.id].some(e => e.kind === 'calls');
    const fn = FG.model.N.find(n => calls(n) && FG.body(n.id)) || FG.model.N.find(calls);
    $('search').value = fn.name.split('(')[0]; $('search').dispatchEvent(new Event('input'));
    expect('the search lists hits', $('hits').children.length > 0 && $('hits').style.display === 'block');
    key($('search'), 'Enter');
    await wait(800);
    expect('Enter makes the first hit the root', FG.state.roots.size === 1 && $('hits').style.display === 'none' && $('search').value === '');
    const root = [...FG.state.roots][0];
    expect('the panel shows the root', $('side').querySelector('h2').textContent === FG.model.N[root].name && $('side').querySelector('[data-drop]'));

    $('down').value = '0'; $('down').dispatchEvent(new Event('change'));
    await wait(500);
    const few = FG.scope.order.length;
    $('down').value = '-1'; $('down').dispatchEvent(new Event('change'));
    await wait(800);
    expect('the depth changes the scope', FG.state.down === -1 && FG.scope.order.length > few);

    const row = $('side').querySelector('.row[data-id]');
    row.click();
    expect('a row of the panel selects its symbol', FG.state.selected === +row.dataset.id);
    $('side').querySelector('[data-mark^="u:"]').click();
    expect('the mark is set and listed', FG.isMarked(FG.state.selected) && $('marks').querySelector('[data-unmark]'));
    $('marks').querySelector('[data-unmark]').click();
    expect('the mark is taken off', !FG.isMarked(FG.state.selected) && !$('marks').querySelector('[data-unmark]'));

    const box = $('kinds').querySelector('[data-kind="calls"]');
    box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true }));
    expect('a kind of edge turns off', FG.state.off.has('calls'));
    box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));

    for (const tab of $('tabs').children) { tab.click(); await wait(400); }
    expect('each view mounts', FG.views.every(v => v.mounted));
    FG.activate('table');
    await wait(300);
    expect('the table has rows', document.querySelectorAll('.tbl .tr').length > 0);
    FG.activate('trace');
    FG.select(root, null);
    await wait(300);
    expect('the trace has an outline, or says that there is none', FG.views.find(v => v.id === 'trace').box.textContent.length > 0);

    FG.setBase(await get('base.json'), 'base.json');
    await wait(400);
    expect('the diff has its controls', $('diffbutton').textContent === 'Changes' && $('diffinfo').querySelector('[data-diff="side"]') && FG.state.diffShow === 'changed');
    const side = $('diffinfo').querySelector('[data-diff="side"]');
    side.value = 'base'; side.dispatchEvent(new Event('change', { bubbles: true }));
    expect('the side changes', FG.state.side === 'base');
    const before = JSON.stringify(FG.diff.counts);
    $('diffinfo').querySelector('[data-diff="swap"]').click();
    await wait(400);
    expect('the swap turns added and removed around', FG.diff.counts.added === JSON.parse(before).removed && /head\.json/.test($('diffinfo').textContent));
    $('diffinfo').querySelector('[data-diff="off"]').click();
    await wait(300);
    expect('the diff ends', !FG.diff && $('diffbutton').textContent === 'Diff…' && !$('diffinfo').textContent);
    console.log('PASS controls');
  } catch (e) { console.log('FAIL controls: ' + e.message); }
})();
