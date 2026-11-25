// The Changes view: with no base it leads to the library, and with a base it lists what changed.
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const expect = (what, ok) => { if (!ok) throw new Error(what); };
  const get = async name => (await fetch(name)).json();
  try {
    FG.load(await get('head.json'), 'head.json');
    FG.activate('diff');
    await wait(200);
    document.querySelector('[data-choose]').click();
    await wait(300);
    const lib = document.getElementById('library');
    expect('the button of the view shows the library with a note', lib.classList.contains('on') && /base/.test(lib.querySelector('.note')?.textContent));
    FG.setBase(await get('base.json'), 'base.json');
    await wait(300);
    const counts = FG.diff.counts;
    expect('the two snapshots differ', counts.added + counts.removed + counts.signature + counts.body > 0);
    expect('the view lists the changes', !lib.classList.contains('on') && document.querySelectorAll('.dif .li [data-id]').length > 0);
    console.log('PASS changes');
  } catch (e) { console.log('FAIL changes: ' + e.message); }
})();
