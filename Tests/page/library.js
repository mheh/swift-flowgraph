// The library in two visits: the first adds two snapshots and compares them, the second finds them kept and deletes them.
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const file = async name => new File([await (await fetch(name)).blob()], name);
  const expect = (what, ok) => { if (!ok) throw new Error(what); };
  const lib = document.getElementById('library');
  const rows = () => [...lib.querySelectorAll('.lrow:not(.lhead)')];
  const press = async (row, act) => { rows()[row].querySelector(`[data-act="${act}"]`).click(); await wait(300); };
  await wait(300);
  try {
    if (!location.search.includes('second')) {
      expect('the page starts with the empty library', lib.classList.contains('on') && document.body.classList.contains('empty') && !rows().length);
      await FGLibrary.add([await file('head.json')]);
      expect('one file opens at once', !lib.classList.contains('on') && FG.model.N.length > 0);
      await FGLibrary.add([await file('base.json'), new File(['{"x":1}'], 'bad.json')]);
      expect('a second file shows the library with two rows', lib.classList.contains('on') && rows().length === 2);
      expect('a file that is no snapshot gives an error', /bad\.json/.test(lib.querySelector('.err')?.textContent));
      await press(0, 'base');
      expect('the base starts the diff', !lib.classList.contains('on') && FG.diff && /base\.json/.test(document.getElementById('diffinfo').textContent));
      location.search = '?second';
    } else {
      expect('the second visit has both snapshots', rows().length === 2);
      await press(1, 'open');
      expect('a kept snapshot opens', !lib.classList.contains('on') && FG.model.N.length > 0);
      await FGLibrary.show();
      await press(0, 'delete');
      expect('a deleted snapshot leaves the list', rows().length === 1);
      await press(0, 'delete');
      expect('the open snapshot stays in the list, not kept', rows().length === 1 && /not kept/.test(rows()[0].textContent) && !(await FGStore.list()).length);
      console.log('PASS library');
    }
  } catch (e) { console.log('FAIL library: ' + e.message); }
})();
