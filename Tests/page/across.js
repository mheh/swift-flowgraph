// Two projects that share no identity: the page matches their symbols by name, and a pair that calls other functions differs.
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const expect = (what, ok) => { if (!ok) throw new Error(what); };
  const get = async name => (await fetch(name)).json();
  try {
    const head = await get('head.json'), other = await get('head.json');
    other.usrs = other.usrs.map(usr => 'other:' + usr);
    other.modules = other.modules.map(module => module + 'Port');
    const calls = other.edgeKinds.indexOf('calls'), own = i => other.symbols[i][6] === 0;
    const cut = other.edges.findIndex(e => e[2] === calls && own(e[0]) && own(e[1]) && e[0] !== e[1]);
    const [from] = other.edges.splice(cut, 1)[0];
    delete other.bodies;
    FG.load(head, 'head.json');
    FG.setBase(other, 'other.json');
    await wait(400);
    const D = FG.diff, total = D.N.filter(n => !n.ext && n.id < D.headCount).length;
    expect('the two count as two projects', D.across);
    expect('most symbols have a pair by name', D.named.size > 0.8 * total);
    expect('the function that lost a call differs, and no other pair does', D.counts.body === 1 && D.N[from].diff === 'body');
    FG.activate('diff');
    await wait(200);
    expect('the view counts the functions of each module of the base', document.querySelectorAll('.dif .port [data-module]').length === new Set(D.base.N.filter(n => !n.ext && /function|method|constructor/i.test(n.kind)).map(n => n.module)).size);
    expect('no symbol is affected across two projects', D.counts.affected === 0);
    expect('the view says that the two are two projects', /two projects/.test(document.querySelector('.dif').textContent));
    console.log(`TIME ${D.named.size} of ${total} symbols have a pair`);
    console.log('PASS across');
  } catch (e) { console.log('FAIL across: ' + e.message); }
})();
