'use strict';
// The model of one snapshot: what the page makes of the rows of the file. No view reads the rows.
//
// The snapshot format, version 1 (flowgraph snapshot writes it):
//   format: 'flowgraph', version: 1
//   project: { name, commit, branch, dirty, created, indexed, staleFiles, unindexedFiles }: staleFiles source files changed after the index was written,
//     and the build did not compile unindexedFiles source files, so the snapshot has no symbol of them
//   files, kinds, modules, packages, edgeKinds: lists of strings that the rows below index
//   symbols: one row for each symbol: [name, kind, file, line, parent, module, external, entry, package]. external: 0 the project, 1 a dependency, 2 the standard library or the SDK
//   usrs: the compiler identifier of each symbol, in the order of symbols
//   edges: one row for each edge: [from, to, edgeKind, count, line of the first site]
//   products: [{ name, type, package }], moduleProducts: { module: [product] }. type: executable, library, or binary for a build with no packages
//   a kind of a symbol is a word of the index (function, struct, field, …), or functionField or functionVariable for a field or a variable that the code calls
//   decl, doc: { symbol index: text }
//   stepKinds: the kinds of the steps of a body
//   bodies: { symbol index: [flags, last line, steps] }: the outline of the body of a function. flags: 1 async, 2 throws
//     a step is [stepKind, line, text, refs, flags, children], and the end of the row is left out when it is empty
//     text: the first line of the step, or [first line, hash] when the step has more text than that: the hash is of the whole step
//     refs: [symbol, edgeKind, symbol, edgeKind, …]: what the step itself uses. flags: 1 try, 2 try? or try!, 4 await
//   labels: { symbol index: text }: for an entry point that the project hands to another module, the call that takes it
//   replace: what the project marks for replacement in flowgraph.json: the name of a module, or Module.name of a symbol
//   view: { roots, up, down, group, fnOnly, product }: the first view of the page

/**
 * @typedef {Object} Sym
 * @property {number} id        index in model.N
 * @property {string} name
 * @property {string} kind      the kind that the compiler gives, for example 'function' or 'struct'
 * @property {'fn'|'data'|'type'} cls
 * @property {number} file      index in model.files, or -1 for a symbol of another module
 * @property {number} line
 * @property {number} parent    id of the type that holds it, or -1
 * @property {string} module
 * @property {boolean} ext      true for a symbol of another module
 * @property {boolean} sys      true for a symbol of the standard library or of the SDK
 * @property {boolean} entry    true for an entry point
 * @property {string} pkg
 * @property {string} usr
 *
 * @typedef {Object} Step
 * @property {string} kind      'stmt', 'return', 'throw', 'guard', 'if', 'else', 'case', 'for', 'do', 'catch', 'closure', … (model.stepKinds)
 * @property {number} line
 * @property {string} text      the first line of the source of the step: the condition of a branch, the expression of a statement
 * @property {{to: number, kind: string}[]} refs  what the step itself uses, with no child
 * @property {number} flags     1 try, 2 try? or try!, 4 await
 * @property {Step[]} children
 * @property {number} hash      a hash of the whole text of the step, or 0 when `text` is all of it
 * @property {string} [diff]    with a base chosen: '+' only the head has it, '-' only the base, '~' it changed and `was` holds the base, '' the same
 *
 * @typedef {Object} Exit        one way out of a function
 * @property {'return'|'throw'|'try'|'end'} type  try: an error of a callee leaves here. end: the body ends with no return
 * @property {number} line
 * @property {string} text
 * @property {string[]} when    the branches that lead to it, from the outside in
 * @property {number[]} callees for try: the callees that can throw
 * @property {boolean} caught   a catch of this function takes the error
 *
 * @typedef {Object} Edge
 * @property {number} from
 * @property {number} to
 * @property {string} kind      one of model.edgeKinds
 * @property {number} count     the number of sites
 * @property {number} line      the line of the first site, in the file of `from`
 *
 * @typedef {Object} Model
 * @property {Object} project
 * @property {string[]} files
 * @property {string[]} edgeKinds
 * @property {Sym[]} N
 * @property {Edge[]} E
 * @property {Edge[][]} out     the edges that leave each symbol
 * @property {Edge[][]} inc     the edges that arrive at each symbol
 * @property {number[][]} kids  the members of each symbol
 * @property {Sym[]} entries
 * @property {boolean} [merged] true with a base chosen: the model then holds the symbols and the edges of both snapshots, each with `diff` (see diff.js)
 */

const FGModel = (() => {
  const clsOf = kind => /function|Method|constructor|destructor/.test(kind) ? 'fn' : /variable|field|Property|enumConstant/.test(kind) ? 'data' : 'type';

  /** Throws when the object is not a snapshot that this page reads. */
  function check(s) {
    if (!s || s.format !== 'flowgraph') throw new Error('This file is not a flowgraph snapshot.');
    if (s.version !== 1) throw new Error(`This page reads version 1 of the snapshot format, and the file has version ${s.version}.`);
  }
  /** @returns {Model} */
  function decode(s) {
    check(s);
    const N = s.symbols.map((r, i) => ({ id: i, name: r[0] || `(anonymous ${s.kinds[r[1]]})`, kind: s.kinds[r[1]], cls: clsOf(s.kinds[r[1]]), file: r[2], line: r[3], parent: r[4],
      module: s.modules[r[5]], ext: !!r[6], sys: r[6] === 2, entry: !!r[7], pkg: s.packages[r[8]], usr: s.usrs[i] }));
    const E = s.edges.map(r => ({ from: r[0], to: r[1], kind: s.edgeKinds[r[2]], count: r[3], line: r[4] }));
    const out = N.map(() => []), inc = N.map(() => []), kids = N.map(() => []);
    for (const e of E) { out[e.from].push(e); inc[e.to].push(e); }
    for (const n of N) if (n.parent >= 0) kids[n.parent].push(n.id);
    for (const [i, label] of Object.entries(s.labels || {})) N[i].label = label;
    const entries = N.filter(n => n.entry).sort((a, b) => (a.module + a.name).localeCompare(b.module + b.name));
    return { project: s.project || {}, files: s.files, edgeKinds: s.edgeKinds, products: s.products || [], moduleProducts: s.moduleProducts || {},
      decl: s.decl || {}, doc: s.doc || {}, view: s.view || {}, bodies: s.bodies || {}, stepKinds: s.stepKinds || [], replace: s.replace || [], N, E, out, inc, kids, entries };
  }

  // The outlines of each snapshot that the page holds: the one that it shows, and the base of a diff.
  const bodyCaches = new WeakMap(), exitCaches = new WeakMap();
  const cacheOf = (caches, model) => caches.get(model) || caches.set(model, new Map()).get(model);
  /** The outline of the body of a function, or null. @returns {?{async: boolean, throws: boolean, endLine: number, steps: Step[]}} */
  function bodyIn(M, id) {
    const bodyCache = cacheOf(bodyCaches, M);
    if (bodyCache.has(id)) return bodyCache.get(id);
    const raw = M.bodies[id];
    const step = r => {
      const refs = [], flat = r[3] || [];
      for (let i = 0; i < flat.length; i += 2) refs.push({ to: flat[i], kind: M.edgeKinds[flat[i + 1]] });
      const long = Array.isArray(r[2]);
      return { kind: M.stepKinds[r[0]], line: r[1], text: long ? r[2][0] : r[2], hash: long ? r[2][1] : 0, refs, flags: r[4] || 0, children: (r[5] || []).map(step) };
    };
    const b = raw ? { async: !!(raw[0] & 1), throws: !!(raw[0] & 2), endLine: raw[1], steps: raw[2].map(step) } : null;
    bodyCache.set(id, b);
    return b;
  }
  /** The ways out of a function: each return, each throw, and each try that passes an error of a callee on. @returns {Exit[]} */
  function exitsIn(M, id) {
    const exitCache = cacheOf(exitCaches, M);
    if (exitCache.has(id)) return exitCache.get(id);
    const b = bodyIn(M, id), found = [];
    // A callee of another module has no body in the snapshot, so it counts as one that can throw. An operator does not.
    const canThrow = to => { const c = bodyIn(M, to); return c ? c.throws : /^[A-Za-z_]/.test(M.N[to].name.split('.').pop()); };
    const walk = (steps, when, caught, parentText) => {
      steps.forEach((s, i) => {
        // The body of a closure or of a function inside is another path: its return does not leave this function.
        if (s.kind === 'closure' || s.kind === 'func' || s.kind === 'entry' || s.kind === 'defer') return;
        if (s.kind === 'return' || s.kind === 'throw') found.push({ type: s.kind, line: s.line, text: s.text, when, callees: [], caught: s.kind === 'throw' && caught });
        if (s.flags & 1 && !(s.flags & 2)) found.push({ type: 'try', line: s.line, text: s.text, when, caught,
          callees: s.refs.filter(r => r.kind === 'calls' && canThrow(r.to)).map(r => r.to) });
        const before = steps[i - 1];
        const inner = s.kind === 'guard' ? 'not: ' + s.text : s.kind === 'if' || s.kind === 'else if' ? 'if ' + s.text
          : s.kind === 'else' ? 'else of: ' + (before ? before.text : '') : s.kind === 'case' ? 'case ' + s.text : s.kind === 'default' ? 'default of: ' + (parentText || '')
          : s.kind === 'for' || s.kind === 'while' || s.kind === 'repeat' ? `in ${s.kind} ${s.text}` : s.kind === 'catch' ? 'catch ' + s.text : s.kind === '#if' ? '#if ' + s.text : null;
        const next = steps[i + 1];
        if (s.children.length) walk(s.children, inner ? [...when, inner] : when, caught || (s.kind === 'do' && !!next && next.kind === 'catch'), s.text);
      });
    };
    if (b) {
      walk(b.steps, [], false, '');
      // The body has no end of its own when its last step always leaves: a return, a throw, or a branch whose every arm leaves.
      const leaves = steps => {
        const last = steps[steps.length - 1];
        if (!last) return false;
        if (last.kind === 'return' || last.kind === 'throw') return true;
        if (last.kind === 'switch') { const arms = last.children.filter(c => c.kind === 'case' || c.kind === 'default'); return arms.length > 0 && arms.every(c => leaves(c.children)); }
        if (last.kind === 'else') {
          // Each arm of the chain before the else must leave too.
          for (let i = steps.length - 1; i >= 0; i--) {
            if (!leaves(steps[i].children)) return false;
            if (steps[i].kind === 'if') return true;
          }
        }
        return false;
      };
      if (!leaves(b.steps)) found.push({ type: 'end', line: b.endLine, text: '', when: [], callees: [], caught: false });
      found.sort((x, y) => x.line - y.line);
    }
    exitCache.set(id, found);
    return found;
  }

  return { check, decode, bodyIn, exitsIn };
})();
