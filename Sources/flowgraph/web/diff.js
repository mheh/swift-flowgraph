'use strict';
// The comparison of two snapshots: pure functions of two decoded models. core.js calls them when the user chooses a base.
// The result is one merged model, which each view reads as it reads one snapshot. It holds the symbols and the edges of both sides:
//
//   a symbol has `diff`:  'added'      the head has it, and the base does not
//                         'removed'    the base has it, and the head does not. It comes after the symbols of the head, which keep their numbers
//                         'signature'  the same module, name, and kind, with another signature (another USR)
//                         'body'       the same symbol, and its body or what it uses is not the same. A line that only moved is no change
//                         'affected'   it is the same, and it reaches a symbol that is not
//                         ''           the same
//   Of two projects (`across`), the symbols are matched by name: 'removed' is then what only the base has, 'added' what only the head has,
//   and 'body' a pair that does not call the same functions.
//   an edge has `diff`:   'added', 'removed', or ''. `was` is its count of sites in the base, when that is another count
//   a step has `diff`:    '+' only the head has it, '-' only the base has it, '~' both have it and it changed (`was` holds the base), '' the same
//   a way out has `diff`: '+', '-', or ''
const FGDiff = (() => {
  const FOLLOW = new Set(['calls', 'refs', 'dispatch', 'reads', 'writes']);  // the edges that carry a change to the symbol that uses it
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // What makes a step the same step: its kind, its text (with the hash of what the first line does not show), its flags, and what it uses.
  const ownKey = (s, key) => `${s.kind}\u0001${s.text}\u0001${s.hash}\u0001${s.flags}\u0001${s.refs.map(r => r.kind + key(r.to)).sort().join(',')}`;

  /** The longest common run of two lists of keys, as pairs [i, j]. -1 stands for "not in this list". */
  function lcs(a, b) {
    let start = 0, endA = a.length, endB = b.length;
    while (start < endA && start < endB && a[start] === b[start]) start++;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const out = [];
    for (let i = 0; i < start; i++) out.push([i, i]);
    const n = endA - start, m = endB - start;
    if (n * m > 4e6) {
      // Too long for the table of the comparison: the middle counts as taken out and put in.
      for (let i = start; i < endA; i++) out.push([i, -1]);
      for (let j = start; j < endB; j++) out.push([-1, j]);
    } else if (n || m) {
      const w = m + 1, t = new Uint16Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
        t[i * w + j] = a[start + i] === b[start + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      let i = 0, j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && a[start + i] === b[start + j]) { out.push([start + i, start + j]); i++; j++; }
        else if (j >= m || (i < n && t[(i + 1) * w + j] >= t[i * w + j + 1])) out.push([start + i++, -1]);
        else out.push([-1, start + j++]);
      }
    }
    for (let i = endA, j = endB; i < a.length; i++, j++) out.push([i, j]);
    return out;
  }

  const tokens = s => s.split(/(\s+|[^\w\s])/).filter(t => t !== '');
  /** Two texts as HTML, with the words that only one of them has marked. @returns {[string, string]} */
  function words(a, b) {
    const ta = tokens(a), tb = tokens(b), outA = [], outB = [];
    for (const [i, j] of lcs(ta, tb)) {
      if (i >= 0 && j >= 0) { outA.push(esc(ta[i])); outB.push(esc(tb[j])); }
      else if (i >= 0) outA.push(/\S/.test(ta[i]) ? `<u class="w">${esc(ta[i])}</u>` : esc(ta[i]));
      else outB.push(/\S/.test(tb[j]) ? `<u class="w">${esc(tb[j])}</u>` : esc(tb[j]));
    }
    return [outA.join(''), outB.join('')];
  }
  // Two steps of the same kind are one changed step when they share enough of their words. A branch always is, so that its steps are compared.
  function alike(a, b) {
    if (a.children.length || b.children.length || a.text === b.text) return true;
    const ta = tokens(a.text).filter(t => /\w/.test(t)), tb = new Set(tokens(b.text).filter(t => /\w/.test(t)));
    return ta.filter(t => tb.has(t)).length >= 0.4 * Math.max(ta.length, tb.size, 1);
  }

  /**
   * The merged model of two snapshots.
   * @param {Model} H the head  @param {Model} B the base
   */
  function merge(H, B) {
    const n0 = H.N.length;
    const baseByUsr = new Map(B.N.map(n => [n.usr, n.id]));
    // baseOf: merged symbol → symbol of the base. mid: symbol of the base → merged symbol.
    const baseOf = new Map(), mid = new Map(), signature = new Set();
    for (const n of H.N) { const b = baseByUsr.get(n.usr); if (b != null && !mid.has(b)) { baseOf.set(n.id, b); mid.set(b, n.id); } }
    // A function with another signature has another USR. It is the same function when one symbol on each side has its module, kind, and name.
    const loose = n => `${n.module}|${n.kind}|${n.name.split('(')[0]}`;
    const group = (nodes, matched) => {
      const map = new Map();
      for (const n of nodes) if (!n.ext && n.kind !== 'closure' && !matched.has(n.id)) (map.get(loose(n)) || map.set(loose(n), []).get(loose(n))).push(n.id);
      return map;
    };
    const looseBase = group(B.N, mid);
    for (const [key, ids] of group(H.N, baseOf)) {
      const other = looseBase.get(key);
      if (ids.length === 1 && other && other.length === 1) { baseOf.set(ids[0], other[0]); mid.set(other[0], ids[0]); signature.add(ids[0]); }
    }
    // Two snapshots that share few identities are of two projects, as a project and its port. Their symbols are then matched by name.
    const own = H.N.filter(n => !n.ext).length, named = new Set();
    const across = baseOf.size < own / 2;
    if (across) {
      const found = FGAcross.pairs(H, B, baseOf, mid);
      for (const [h, b] of found.pairs) { baseOf.set(h.id, b.id); mid.set(b.id, h.id); named.add(h.id); }
      for (const [copy, b] of found.copies) mid.set(copy.id, mid.get(b.id));
    }
    // The symbols that only the base has come after the symbols of the head.
    const N = H.N.map(n => ({ ...n, diff: '' })), fileOffset = H.files.length;
    const gone = B.N.filter(n => !mid.has(n.id));
    gone.forEach((n, i) => { mid.set(n.id, n0 + i); baseOf.set(n0 + i, n.id); });
    for (const n of gone) N.push({ ...n, id: mid.get(n.id), parent: n.parent >= 0 ? mid.get(n.parent) : -1, file: n.file >= 0 ? n.file + fileOffset : -1, diff: 'removed' });

    // Both sides name a symbol by its merged number, so a caller of a function with a new signature does not count as changed by that alone.
    const same = id => id, toMerged = id => mid.get(id);
    // Across two projects no text is the same, and each language reads its data in its own way. A pair is the same when both sides call the same functions, of those that both sides have.
    const shared = id => id < n0 && baseOf.has(id);
    const usePrint = (model, id, key) => {
      const calls = new Set();
      for (const e of model.out[id]) {
        const to = key(e.to);
        if (e.kind === 'calls' && shared(to) && !N[to].ext) calls.add(to);
      }
      return [...calls].sort().join(' ');
    };
    const print = (model, id, key) => {
      const b = FGModel.bodyIn(model, id);
      if (!b) return model.out[id].map(e => `${e.kind} ${key(e.to)} ${e.count}`).sort().join('\n');
      const parts = [(b.async ? 'a' : '') + (b.throws ? 't' : '')];
      const walk = (steps, depth) => { for (const s of steps) { parts.push(depth + ownKey(s, key)); walk(s.children, depth + 1); } };
      walk(b.steps, 0);
      return parts.join('\n');
    };
    const states = new Map(), bodyToo = new Set();
    for (const n of H.N) {
      const b = baseOf.get(n.id);
      // A symbol of another module has no state of its own. One that only one side uses is drawn as added or removed.
      if (n.ext) { if (b == null) N[n.id].diff = 'added'; continue; }
      const printed = named.has(n.id) ? usePrint : print;
      const changed = b != null && printed(H, n.id, same) !== printed(B, b, toMerged);
      if (b == null) states.set(n.id, 'added');
      else if (signature.has(n.id)) { states.set(n.id, 'signature'); if (changed) bodyToo.add(n.id); }
      else if (changed) states.set(n.id, 'body');
    }
    // What uses a changed symbol, at any distance, is affected. Of two projects that is nearly each symbol, so none is.
    let frontier = across ? [] : [...states.keys()];
    while (frontier.length) {
      const next = [];
      for (const id of frontier) for (const e of H.inc[id]) {
        if (!FOLLOW.has(e.kind) || states.has(e.from) || H.N[e.from].ext) continue;
        states.set(e.from, 'affected'); next.push(e.from);
      }
      frontier = next;
    }
    const counts = { added: 0, removed: 0, signature: 0, body: 0, affected: 0 };
    for (const [id, s] of states) { N[id].diff = s; counts[s]++; }
    counts.removed = gone.filter(n => !n.ext).length;

    const E = [], at = new Map();
    for (const e of H.E) { const m = { ...e, diff: 'added' }; at.set(`${e.from}>${e.to}>${e.kind}`, m); E.push(m); }
    for (const e of B.E) {
      const from = mid.get(e.from), to = mid.get(e.to), m = at.get(`${from}>${to}>${e.kind}`);
      if (m) { m.diff = ''; if (m.count !== e.count) m.was = e.count; }
      else E.push({ from, to, kind: e.kind, count: e.count, line: e.line, diff: 'removed' });
    }
    const kids = N.map(() => []);
    for (const n of N) if (n.parent >= 0) kids[n.parent].push(n.id);
    const decl = { ...H.decl }, doc = { ...H.doc };
    for (const n of gone) { if (B.decl[n.id]) decl[mid.get(n.id)] = B.decl[n.id]; if (B.doc[n.id]) doc[mid.get(n.id)] = B.doc[n.id]; }
    const entries = N.filter(n => n.entry).sort((a, b) => (a.module + a.name).localeCompare(b.module + b.name));
    return { ...H, files: H.files.concat(B.files), N, E, kids, decl, doc, entries, merged: true, head: H, base: B, baseOf, mid, headCount: n0, counts, bodyToo, across, named, labels: across ? ACROSS_LABEL : LABEL,
      bodyCache: new Map(), exitCache: new Map() };
  }

  // --- the two bodies of one symbol, as one outline
  function bodyOf(F, id) {
    if (F.bodyCache.has(id)) return F.bodyCache.get(id);
    const hb = id < F.headCount ? FGModel.bodyIn(F.head, id) : null, bid = F.baseOf.get(id), bb = bid != null ? FGModel.bodyIn(F.base, bid) : null;
    let out = null;
    if (hb || bb) {
      const same = x => x, toMerged = x => F.mid.get(x);
      const mapRefs = refs => refs.map(r => ({ to: F.mid.get(r.to), kind: r.kind }));
      const whole = (s, sign, base) => ({ kind: s.kind, line: s.line, text: s.text, hash: s.hash, flags: s.flags, refs: base ? mapRefs(s.refs) : s.refs, diff: sign,
        children: s.children.map(c => whole(c, sign, base)) });
      const align = (as, bs) => {
        const steps = [];
        let dels = [], adds = [];
        // Between two steps that are the same: a step that left and a step that came are one changed step when they are alike.
        const flush = () => {
          let j = 0;
          for (const d of dels) {
            let k = j;
            while (k < adds.length && !(adds[k].kind === d.kind && alike(d, adds[k]))) k++;
            if (k === adds.length) { steps.push(whole(d, '-', true)); continue; }
            for (; j < k; j++) steps.push(whole(adds[j], '+', false));
            const h = adds[j++];
            steps.push({ kind: h.kind, line: h.line, text: h.text, hash: h.hash, flags: h.flags, refs: h.refs, diff: '~',
              was: { line: d.line, text: d.text, hash: d.hash, flags: d.flags, refs: mapRefs(d.refs) }, children: align(d.children, h.children) });
          }
          for (; j < adds.length; j++) steps.push(whole(adds[j], '+', false));
          dels = []; adds = [];
        };
        for (const [i, j] of lcs(as.map(s => ownKey(s, toMerged)), bs.map(s => ownKey(s, same)))) {
          if (i >= 0 && j >= 0) {
            flush();
            const h = bs[j];
            steps.push({ kind: h.kind, line: h.line, text: h.text, hash: h.hash, flags: h.flags, refs: h.refs, diff: '', children: align(as[i].children, h.children) });
          } else if (i >= 0) dels.push(as[i]);
          else adds.push(bs[j]);
        }
        flush();
        return steps;
      };
      const one = hb || bb;
      out = { async: one.async, throws: one.throws, endLine: one.endLine, steps: align(bb ? bb.steps : [], hb ? hb.steps : []),
        was: hb && bb && (hb.async !== bb.async || hb.throws !== bb.throws) ? { async: bb.async, throws: bb.throws, endLine: bb.endLine } : null };
    }
    F.bodyCache.set(id, out);
    return out;
  }
  // One side of a merged body: the head with no step that left, or the base with no step that came.
  function sidedBody(b, side) {
    if (!b || side === 'both') return b;
    const drop = side === 'head' ? '-' : '+';
    const walk = steps => steps.filter(s => s.diff !== drop).map(s => s.diff !== '~' ? { ...s, children: walk(s.children) }
      : side === 'head' ? { ...s, diff: '+', was: null, children: walk(s.children) } : { ...s, ...s.was, diff: '-', was: null, children: walk(s.children) });
    return { ...b, ...(side === 'base' && b.was ? b.was : {}), was: null, steps: walk(b.steps) };
  }
  function exitsOf(F, id) {
    if (F.exitCache.has(id)) return F.exitCache.get(id);
    const bid = F.baseOf.get(id);
    const he = id < F.headCount ? FGModel.exitsIn(F.head, id) : [], be = bid != null ? FGModel.exitsIn(F.base, bid) : [];
    const key = e => `${e.type}\u0001${e.text}\u0001${e.when.join(' → ')}\u0001${e.caught ? 1 : 0}`;
    const left = new Map();
    for (const e of be) left.set(key(e), (left.get(key(e)) || 0) + 1);
    const out = he.map(e => { const k = key(e), n = left.get(k) || 0; if (n) left.set(k, n - 1); return { ...e, diff: n ? '' : '+' }; });
    for (const e of [...be].reverse()) { const k = key(e), n = left.get(k) || 0; if (n) { left.set(k, n - 1); out.push({ ...e, callees: e.callees.map(c => F.mid.get(c)), diff: '-' }); } }
    out.sort((x, y) => x.line - y.line);
    F.exitCache.set(id, out);
    return out;
  }

  /**
   * The merged model as one side shows it. The numbers of the symbols are the same for each side.
   * @param {'both'|'head'|'base'} side
   */
  function view(F, side) {
    const E = side === 'both' ? F.E : F.E.filter(e => e.diff !== (side === 'head' ? 'removed' : 'added'));
    const out = F.N.map(() => []), inc = F.N.map(() => []);
    for (const e of E) { out[e.from].push(e); inc[e.to].push(e); }
    const bodies = new Map(), exits = new Map(), drop = side === 'head' ? '-' : '+';
    const cached = (map, id, make) => { if (!map.has(id)) map.set(id, make()); return map.get(id); };
    return { ...F, E, out, inc, side,
      /** True when this side has the symbol. */
      onSide: n => !(side === 'head' && n.diff === 'removed') && !(side === 'base' && n.diff === 'added'),
      body: id => cached(bodies, id, () => sidedBody(bodyOf(F, id), side)),
      exits: id => cached(exits, id, () => side === 'both' ? exitsOf(F, id) : exitsOf(F, id).filter(e => e.diff !== drop)) };
  }

  const LABEL = { added: 'added', removed: 'removed', signature: 'signature changed', body: 'body changed', affected: 'affected' };
  const ACROSS_LABEL = { ...LABEL, added: 'only in the head', removed: 'only in the base', body: 'calls differ' };
  const SIGN = { added: '+', removed: '−', signature: '≠', body: '~', affected: '·' };
  const ORDER = ['added', 'removed', 'signature', 'body', 'affected'];
  return { merge, view, words, SIGN, ORDER };
})();
