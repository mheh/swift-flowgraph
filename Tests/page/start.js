// The start of the graph view: with no root it offers the entry points, and one click draws the graph of an entry.
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const expect = (what, ok) => { if (!ok) throw new Error(what); };
  try {
    FG.load(await (await fetch('head.json')).json(), 'head.json');
    await wait(300);
    const hint = document.querySelector('.ghint');
    expect('with no root, the view offers each entry point', hint.classList.contains('on') && hint.querySelectorAll('[data-entry]').length === FG.model.entries.length);
    hint.querySelector('[data-entry]').click();
    await wait(1500);
    expect('an entry point becomes the root', !hint.classList.contains('on') && FG.state.roots.size === 1 && FG.scope.order.length > 1);
    document.querySelector('[data-drop]').click();
    await wait(300);
    expect('with the root taken away, the offer is back', hint.classList.contains('on'));
    console.log('PASS start');
  } catch (e) { console.log('FAIL start: ' + e.message); }
})();
