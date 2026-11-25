// The Trace view: the outline of a body, a call opened in place, and the rows of a changed body with a base.
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const expect = (what, ok) => { if (!ok) throw new Error(what); };
  const get = async name => (await fetch(name)).json();
  const rows = sel => document.querySelectorAll('.trc .ls ' + sel).length;
  try {
    FG.load(await get('head.json'), 'head.json');
    const { N } = FG.model;
    const caller = N.find(n => FG.body(n.id)?.steps.some(s => s.refs.some(r => r.kind === 'calls' && FG.body(r.to))));
    expect('a function with a body calls another one', caller);
    FG.setRoot(caller.id, false);
    FG.activate('trace');
    await wait(200);
    const steps = rows('.tl');
    expect('the outline has a row for each step', steps > 0 && document.querySelector('.trc .hd').textContent.includes(caller.name));
    document.querySelector('.trc [data-exp]').click();
    await wait(100);
    expect('an opened call shows its body below it', rows('.tl.into') === 1 && rows('.tl') > steps + 1);
    expect('the status counts the steps', /\d+ steps · \d+ returns/.test(document.getElementById('status').textContent));

    FG.setBase(await get('base.json'), 'base.json');
    await wait(300);
    const changed = FG.model.N.find(n => n.diff === 'body');
    expect('a body changed between the two snapshots', changed);
    FG.setRoot(changed.id, false);
    FG.activate('trace');
    await wait(200);
    expect('a changed body has added or removed rows', rows('.tl.add') + rows('.tl.del') > 0);
    console.log(`TIME changed body: +${rows('.tl.add')} −${rows('.tl.del')} ~${rows('.tl.chg')}`);
    console.log('PASS trace');
  } catch (e) { console.log('FAIL trace: ' + e.message); }
})();
