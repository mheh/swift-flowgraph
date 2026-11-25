'use strict';
// The match of two snapshots that share no identities, as a C project and its port to Swift: by the name of each symbol and by what kind of thing it is.
const FGAcross = (() => {
  const CLASSES = [
    ['data', /^function(Field|Variable)$|field|variable|property|enumConstant|macro/i],
    ['callable', /function|method|constructor|destructor|initializer|subscript/i],
    ['type', /struct|class|enum|union|typealias|protocol/i],
  ];
  const classOf = kind => (CLASSES.find(([, pattern]) => pattern.test(kind)) || [null])[0];
  const fullName = n => n.name.replace(/\(.*/, '');
  const lastName = n => fullName(n).split('.').pop();

  function grouped(nodes, key) {
    const map = new Map();
    for (const n of nodes) {
      const k = key(n);
      if (k) (map.get(k) || map.set(k, []).get(k)).push(n);
    }
    return map;
  }

  // For each module of the head, the module of the base that most of its pairs are in.
  function modulesOf(pairs) {
    const counts = new Map();
    for (const [h, b] of pairs) {
      const of = counts.get(h.module) || counts.set(h.module, new Map()).get(h.module);
      of.set(b.module, (of.get(b.module) || 0) + 1);
    }
    return new Map([...counts].map(([module, of]) => [module, [...of].sort((x, y) => y[1] - x[1])[0][0]]));
  }

  // The one pair of a group of symbols that have the same key. With several on a side, the modules must agree.
  function pairIn(heads, bases, modules) {
    if (heads.length === 1 && bases.length === 1) return [heads[0], bases[0]];
    for (const h of heads) {
      const module = modules.get(h.module);
      const mine = bases.filter(b => b.module === module), rivals = heads.filter(x => modules.get(x.module) === module);
      if (module != null && mine.length === 1 && rivals.length === 1) return [h, mine[0]];
    }
    return null;
  }

  /**
   * The pairs of symbols of two models that no identity matched.
   * @param {Set<number>} matchedHead @param {Set<number>|Map} matchedBase the symbols that have a partner already
   * @returns {{pairs: [object, object][], copies: [object, object][]}} each pair is a symbol of the head and a symbol of the base.
   *   A copy is a symbol of the base and the paired symbol of the base that it repeats: one function that several binaries of the base compile.
   */
  function pairs(H, B, matchedHead, matchedBase) {
    const open = (model, matched) => model.N.filter(n => !n.ext && !matched.has(n.id) && classOf(n.kind));
    let heads = open(H, matchedHead), bases = open(B, matchedBase);
    const out = [], copies = [];
    const round = (name, modules) => {
      const key = n => { const text = name(n); return text ? classOf(n.kind) + ' ' + text : null; };
      const byKey = grouped(bases, key), gone = new Set();
      for (const [k, same] of grouped(heads, key)) {
        const pair = byKey.has(k) ? pairIn(same, byKey.get(k), modules) : null;
        if (!pair) continue;
        out.push(pair);
        gone.add(pair[0]).add(pair[1]);
        if (same.length > 1) continue;
        for (const b of byKey.get(k)) if (b !== pair[1]) { copies.push([b, pair[1]]); gone.add(b); }
      }
      heads = heads.filter(n => !gone.has(n));
      bases = bases.filter(n => !gone.has(n));
    };
    const callable = n => classOf(n.kind) === 'callable' ? lastName(n) : null;
    round(fullName, new Map());
    round(fullName, modulesOf(out));
    round(callable, new Map());
    round(callable, modulesOf(out));
    return { pairs: out, copies };
  }

  return { pairs };
})();
