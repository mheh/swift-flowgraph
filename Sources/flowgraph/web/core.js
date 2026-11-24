'use strict';
// The core of the page. It reads one snapshot, holds the state that all views share, and gives the views
// the part of the graph that the roots reach. A view is one file that calls FG.registerView.
//
// The snapshot format, version 1 (flowgraph snapshot writes it):
//   format: 'flowgraph', version: 1
//   project: { name, commit, branch, dirty, created, indexed, staleFiles }: staleFiles source files changed after the index was written
//   files, kinds, modules, packages, edgeKinds: lists of strings that the rows below index
//   symbols: one row for each symbol: [name, kind, file, line, parent, module, external, entry, package]. external: 0 the project, 1 a dependency, 2 the standard library or the SDK
//   usrs: the compiler identifier of each symbol, in the order of symbols
//   edges: one row for each edge: [from, to, edgeKind, count, line of the first site]
//   products: [{ name, type, package }], moduleProducts: { module: [product] }
//   decl, doc: { symbol index: text }
//   stepKinds: the kinds of the steps of a body
//   bodies: { symbol index: [flags, last line, steps] }: the outline of the body of a function. flags: 1 async, 2 throws
//     a step is [stepKind, line, text, refs, flags, children], and the end of the row is left out when it is empty
//     text: the first line of the step, or [first line, hash] when the step has more text than that: the hash is of the whole step
//     refs: [symbol, edgeKind, symbol, edgeKind, …]: what the step itself uses. flags: 1 try, 2 try? or try!, 4 await
//   labels: { symbol index: text }: for an entry point that the project hands to another module, the call that takes it
//   replace: what the project marks for replacement in flowgraph.json: the name of a module, or Module.name of a symbol
//   view: { roots, up, down, group, fnOnly, product }: the first view of the page
//
// A view never reads the rows. It reads the model that decode() makes from them.

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
 *
 * @typedef {Object} Scope
 * @property {Map<number, number>} dist  each symbol that the roots reach, with its distance from the nearest root
 * @property {number[]} order            the same symbols, nearest first
 *
 * @typedef {Object} View
 * @property {string} id
 * @property {string} title
 * @property {(box: HTMLElement, bar: HTMLElement) => void} mount  called once, before the first update
 * @property {(scope: Scope) => void} update   called when the view is shown and after each change of the state
 * @property {(id: ?number, reveal: boolean) => void} [select]  the selection changed; reveal: another part of the page chose it
 * @property {() => string} [panel]             HTML for the head of the side panel
 * @property {(ev: MouseEvent) => boolean} [panelClick]  a click in the side panel; true when the view took it
 * @property {(id: number) => boolean} [has]   true when the view shows the symbol; the default is the scope
 * @property {() => void} [reset]              a new snapshot was loaded
 */

const FG = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const short = n => { const s = typeof n === 'string' ? n : n.name; return s.length > 46 ? s.slice(0, 44) + '…' : s; };
  const EDGE_COLOR = { calls: '#5aa9e6', refs: '#7f8fd9', reads: '#e6b35a', writes: '#e6705a', uses: '#8fd48f', inherits: '#c58fd4', dispatch: '#9aa3b2' };
  const params = new URLSearchParams(location.search);
  const clsOf = kind => /function|Method|constructor|destructor/.test(kind) ? 'fn' : /variable|field|Property|enumConstant/.test(kind) ? 'data' : 'type';

  /** @type {View[]} */
  const views = [];
  /** @type {?Model} */
  let M = null;
  /** @type {?View} */
  let active = null;
  /** @type {Scope} */
  let scope = { dist: new Map(), order: [] };

  // hidden: taken out, with all that only it leads to. shown: drawn though no depth reaches it. open: its neighbours are drawn too.
  // marks: what is marked for replacement. 'm:Module' is each symbol of a module, 'u:usr' is one symbol with its members.
  // side and diffShow are for a diff: which snapshot the views show, and which symbols of it.
  const state = { side: 'both', diffShow: 'all', marks: [], roots: new Set(), up: 1, down: 2, off: new Set(), selected: null, product: '', group: 'file', data: true, types: true, ext: true, sys: false,
    hidden: new Set(), shown: new Set(), open: new Set() };

  /** @returns {Model} */
  function decode(s) {
    if (!s || s.format !== 'flowgraph') throw new Error('This file is not a flowgraph snapshot.');
    if (s.version !== 1) throw new Error(`This page reads version 1 of the snapshot format, and the file has version ${s.version}.`);
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

  const where = n => n.file >= 0 ? `${M.files[n.file]}:${n.line}` : (n.module || 'other module');
  const productsOf = n => M.moduleProducts[n.module] || [];
  // A product is the set of the targets that are linked into it. With a product chosen, only their symbols are in the scope.
  const inProduct = n => !state.product || productsOf(n).includes(state.product);
  const visible = n => !state.hidden.has(n.id) && inProduct(n) && !(n.ext && !(n.sys ? state.sys : state.ext)) && !(n.cls === 'data' && !state.data) && !(n.cls === 'type' && !state.types)
    && !(M.merged && !M.onSide(n));
  // With a diff, the views can hold only what changed. The walk from the roots still goes through what is the same.
  const passes = n => !M.merged || state.diffShow === 'all' || (state.diffShow === 'changed' ? !!n.diff : !!n.diff && n.diff !== 'affected');
  const allowed = n => visible(n) && passes(n);

  /** @returns {Scope} */
  function reach() {
    const { N, out, inc, kids } = M;
    // A root that is a type stands for its members too, so that "where is this struct used" covers its fields.
    const start = new Set(state.roots);
    // A diff with no root starts from the change itself: each symbol that was added, removed, or changed.
    const fromChange = M.merged && !state.roots.size;
    if (fromChange) for (const n of N) if (n.diff && n.diff !== 'affected' && !n.ext && visible(n)) start.add(n.id);
    for (const r of state.roots) if (N[r].cls === 'type') for (const k of kids[r]) start.add(k);
    const dist = new Map([...start].map(r => [r, 0]));
    const walk = (adj, end, max) => {
      let frontier = [...start];
      for (let d = 1; frontier.length && (max < 0 || d <= max); d++) {
        const next = [];
        for (const n of frontier) for (const e of adj[n]) {
          const m = e[end];
          if (state.off.has(e.kind) || dist.has(m) || !visible(N[m])) continue;
          dist.set(m, d); next.push(m);
        }
        frontier = next;
      }
    };
    if (start.size) {
      walk(out, 'to', state.down);
      walk(inc, 'from', state.up);
      // What the user asked for by hand comes after the roots and before the rest, so a limit of a view does not cut it.
      for (const id of state.shown) if (!dist.has(id)) dist.set(id, 0.5);
      for (const id of state.open) {
        if (!dist.has(id)) continue;
        for (const [adj, end] of [[out, 'to'], [inc, 'from']]) for (const e of adj[id]) {
          const m = e[end];
          if (!state.off.has(e.kind) && !dist.has(m) && visible(N[m])) dist.set(m, 0.75);
        }
      }
    }
    for (const [id, d] of dist) if (d !== 0 && !passes(N[id])) dist.delete(id);
    // In the change, the functions come first, so that a limit of a view keeps them.
    const rank = id => fromChange && N[id].cls !== 'fn' ? 1 : 0;
    const order = [...dist.entries()].sort((a, b) => a[1] - b[1] || rank(a[0]) - rank(b[0]) || a[0] - b[0]).map(e => e[0]);
    return { dist, order };
  }

  // --- the bodies
  // The outlines of each snapshot that the page holds: the one that it shows, and the base of a diff.
  const bodyCaches = new WeakMap(), exitCaches = new WeakMap();
  const cacheOf = (caches, model) => caches.get(model) || caches.set(model, new Map()).get(model);
  // With a base chosen, the body of a symbol is the two bodies as one outline, and its ways out are those of both.
  const body = id => M.merged ? M.body(id) : bodyIn(M, id), exits = id => M.merged ? M.exits(id) : exitsIn(M, id);
  // H: the snapshot of the page. F: H merged with the base of a diff, or null. M is what the views read: H, or one side of F.
  let H = null, F = null, raw = null, baseModel = null, baseRaw = null, baseName = '', linked = false;
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

  // --- the marks for replacement
  let markedIds = new Set();
  const isMarked = id => markedIds.has(id);
  const markKey = n => 'u:' + n.usr;
  const markName = key => key[0] === 'm' ? 'module ' + key.slice(2) : (M.N.find(n => n.usr === key.slice(2)) || { name: key.slice(2) }).name;
  const storeKey = () => 'flowgraph.marks.' + (M.project.name || '');
  function applyMarks() {
    markedIds = new Set();
    const modules = new Set(state.marks.filter(k => k[0] === 'm').map(k => k.slice(2))), usrs = new Set(state.marks.filter(k => k[0] === 'u').map(k => k.slice(2)));
    const add = id => { if (markedIds.has(id)) return; markedIds.add(id); for (const k of M.kids[id]) add(k); };
    for (const n of M.N) if (modules.has(n.module) || usrs.has(n.usr)) add(n.id);
    $('marks').innerHTML = `<span class="dim" title="Mark what you plan to replace: select a symbol, then Mark in the panel. Each view shows where it is used.">replace:</span> `
      + (state.marks.map(k => `<span class="chip mark">▣ ${esc(short(markName(k)))} <b data-unmark="${esc(k)}">×</b></span>`).join('') || '<span class="dim">nothing marked</span>');
  }
  function toggleMark(key) {
    const i = state.marks.indexOf(key);
    i < 0 ? state.marks.push(key) : state.marks.splice(i, 1);
    try { localStorage.setItem(storeKey(), JSON.stringify(state.marks)); } catch (e) { /* a page from a file can have no storage */ }
    applyMarks(); refresh();
  }
  /** Each place in the body of a function, and in the bodies below it, that uses a marked symbol. */
  function markedBelow(id) {
    const sites = [], seen = new Set([id]), queue = [id];
    while (queue.length && sites.length < 2000) {
      const fn = queue.shift(), b = body(fn);
      if (!b) continue;
      const walk = steps => { for (const s of steps) {
        for (const r of s.refs) {
          if (isMarked(r.to)) sites.push({ fn, line: s.line, to: r.to, kind: r.kind });
          else if ((r.kind === 'calls' || r.kind === 'refs') && !seen.has(r.to)) { seen.add(r.to); queue.push(r.to); }
        }
        walk(s.children);
      } };
      walk(b.steps);
    }
    return sites;
  }

  // --- the diff: a base snapshot beside the snapshot of the page
  function remodel() { M = F ? FGDiff.view(F, state.side) : H; }
  /** Sets the base of the diff: a snapshot object, or null to end the diff. Every view then shows both snapshots. */
  function setBase(snapshot, name) {
    baseRaw = snapshot; baseName = name || '';
    baseModel = snapshot ? decode(snapshot) : null;
    if (baseModel) baseModel.name = baseName;
    rebase(true);
    refresh();
  }
  function rebase(narrow) {
    F = baseModel ? FGDiff.merge(H, baseModel, { bodyIn, exitsIn }) : null;
    if (!F) {
      // The symbols that only the base had are gone.
      const gone = id => id >= H.N.length;
      for (const set of [state.roots, state.hidden, state.shown, state.open]) for (const id of [...set]) if (gone(id)) set.delete(id);
      if (state.selected != null && gone(state.selected)) state.selected = null;
      for (const view of views) if (view.mounted && view.reset) view.reset();
    }
    state.side = 'both';
    // The views start with what changed and what reaches a change.
    state.diffShow = F && narrow ? 'changed' : 'all';
    remodel();
    applyMarks();
  }
  function setSide(side) { state.side = side; remodel(); refresh(); }
  function swapDiff() {
    const head = raw, headName = H.name;
    const next = baseRaw, nextName = baseName;
    // The roots and the selection stay, when the other snapshot has them.
    const roots = [...state.roots].map(id => M.N[id].usr), picked = state.selected != null ? M.N[state.selected].usr : null, show = state.diffShow;
    baseRaw = head; baseName = headName; baseModel = H;
    load(next, nextName);
    const byUsr = new Map(M.N.map(n => [n.usr, n.id]));
    const found = roots.map(u => byUsr.get(u)).filter(id => id != null);
    if (found.length) state.roots = new Set(found);
    state.selected = byUsr.get(picked) ?? null;
    state.diffShow = show;
    refresh();
  }
  function syncDiff() {
    $('diffbutton').textContent = F ? 'Changes' : 'Diff…';
    if (!F) { $('diffinfo').innerHTML = ''; return; }
    const p = baseModel.project, option = (value, text, now) => `<option value="${value}"${value === now ? ' selected' : ''}>${text}</option>`;
    $('diffinfo').innerHTML = `<span class="chip" title="The base of the diff. The snapshot of the page is the head.">base: ${esc([baseName, p.branch, p.commit].filter(Boolean).join(' · '))}`
      + ` <b data-diff="swap" title="Swap the base and the head">⇄</b> <b data-diff="off" title="End the diff">×</b></span>`
      + ` <label title="Which symbols the views hold">show <select data-diff="show">${option('all', 'all', state.diffShow)}${option('changed', 'changed + affected', state.diffShow)}${option('only', 'changed only', state.diffShow)}</select></label>`
      + ` <label title="Which snapshot the views show: both as one, the head alone (the new code), or the base alone (the old code)">side <select data-diff="side">${option('both', 'both', state.side)}${option('head', 'head only', state.side)}${option('base', 'base only', state.side)}</select></label>`;
  }

  function status(text, warn) { $('status').className = warn ? 'warn' : ''; $('status').textContent = text; }

  // --- the controls show the state
  function sync() {
    for (const id of ['up', 'down']) {
      if (![...$(id).options].some(o => +o.value === state[id])) $(id).insertAdjacentHTML('beforeend', `<option value="${state[id]}">${state[id]}</option>`);
      $(id).value = state[id];
    }
    $('group').value = state.group; $('product').value = state.product;
    for (const id of ['data', 'types', 'ext', 'sys']) $(id).checked = state[id];
    for (const box of $('kinds').querySelectorAll('input')) box.checked = !state.off.has(box.dataset.kind);
    syncDiff();
  }

  /** Works the scope out again and gives it to the view that is shown. Call it after each change of the state. */
  function refresh() {
    if (!M || !active) return;
    sync();
    scope = reach();
    if (!active.mounted) { active.mount(active.box, $('viewbar')); active.mounted = true; }
    active.update(scope);
    panel();
  }

  function activate(id) {
    active = views.find(v => v.id === id) || views[0];
    for (const v of views) { v.box.classList.toggle('on', v === active); v.tab.classList.toggle('on', v === active); }
    $('viewbar').innerHTML = '';
    if (active.mounted && active.bar) active.bar($('viewbar'));
    refresh();
  }

  /** @param {View} view */
  function registerView(view) { views.push(view); }

  // --- actions that every view can call
  function select(id, source) {
    state.selected = id;
    if (active && active.select) active.select(id, source !== active);
    panel();
  }
  function setRoot(id, add) {
    if (!add) state.roots.clear();
    state.roots.add(id);
    state.selected = id;
    $('hits').style.display = 'none';
    $('search').value = '';
    location.hash = [...state.roots].map(r => encodeURIComponent(M.N[r].name)).join('&');
    refresh();
  }
  function hide(id) { if (state.roots.has(id)) return; state.hidden.add(id); state.shown.delete(id); state.open.delete(id); if (state.selected === id) state.selected = null; refresh(); }
  function show(id) { state.hidden.delete(id); state.shown.add(id); state.selected = id; refresh(); }
  function toggleOpen(id) { state.open.has(id) ? state.open.delete(id) : state.open.add(id); refresh(); }
  function restore(id) { state.hidden.delete(id); refresh(); }
  // An entry point is shown with all that it reaches, and each of its branches is one group.
  function byEntry() { state.up = 0; state.down = -1; state.data = false; state.types = false; }
  function setEntry(id) { byEntry(); state.group = 'branch'; setRoot(id, false); }
  function setProduct(name) {
    state.product = name;
    state.roots = new Set(name ? M.entries.filter(inProduct).map(n => n.id) : []);
    state.selected = null;
    if (name) { byEntry(); state.group = 'module'; }
    refresh();
  }

  // --- search
  let hitIndex = 0, hitList = [];
  function search(q) {
    q = q.trim().toLowerCase();
    if (!q || !M) return [];
    const scored = [];
    for (const n of M.N) {
      const name = n.name.toLowerCase(), at = name.indexOf(q);
      if (at < 0) continue;
      const base = name.split('(')[0];
      const score = (base === q ? 0 : base.endsWith('.' + q) ? 1 : at === 0 ? 2 : name[at - 1] === '.' ? 3 : 4) * 1000 + (n.ext ? 500 : 0) + name.length;
      scored.push([score, n]);
    }
    return scored.sort((a, b) => a[0] - b[0]).slice(0, 40).map(s => s[1]);
  }
  const rowHTML = (n, extra = '') => `<div class="row" data-id="${n.id}"><span class="dot ${n.cls}"></span><span>${esc(n.name)}</span><span class="where">${extra || esc(where(n))}</span></div>`;
  function showHits() {
    hitList = search($('search').value);
    hitIndex = 0;
    $('hits').innerHTML = hitList.map((n, i) => rowHTML(n).replace('class="row"', `class="row${i ? '' : ' on'}"`)).join('');
    $('hits').style.display = hitList.length ? 'block' : 'none';
  }

  // --- the side panel
  // A row of the panel with a switch: − takes a shown symbol out, + shows one that is not shown.
  const drawn = id => active && active.has ? active.has(id) : scope.dist.has(id);
  const panelRow = (n, extra) => rowHTML(n, extra)
    .replace('<span class="dot', `<b class="sw" data-sw="${n.id}" title="${drawn(n.id) ? 'Hide' : 'Show'}">${drawn(n.id) ? '−' : '+'}</b><span class="dot`)
    .replace('class="row"', `class="row${drawn(n.id) ? '' : ' absent'}"`);
  function list(title, edges, end) {
    if (!edges.length) return '';
    const { N, files } = M, byKind = {};
    for (const e of edges) (byKind[e.kind] = byKind[e.kind] || []).push(e);
    let html = '';
    for (const kind of M.edgeKinds) {
      const es = byKind[kind];
      if (!es) continue;
      es.sort((a, b) => end === 'to' ? a.line - b.line : N[a[end]].name.localeCompare(N[b[end]].name));
      html += `<h3><span style="color:${EDGE_COLOR[kind]}">${kind}</span> ${title} · ${es.length}</h3>`;
      html += es.slice(0, 400).map(e => {
        const site = N[e.from];
        return panelRow(N[e[end]], (e.diff === 'added' ? '<span class="dst d-added">+</span> ' : e.diff === 'removed' ? '<span class="dst d-removed">−</span> ' : '') + esc(`${site.file >= 0 ? files[site.file].split('/').pop() : ''}:${e.line}${e.count > 1 ? ' ×' + e.count : ''}`));
      }).join('');
      if (es.length > 400) html += `<div class="dim">… and ${es.length - 400} more</div>`;
    }
    return html;
  }
  function panel() {
    if (!M) { $('side').innerHTML = ''; return; }
    const { N, out, inc, kids } = M;
    const mine = active && active.panel ? active.panel() : '';
    const chips = [...state.roots].map(r => `<span class="chip">${esc(short(N[r]))} <b data-drop="${r}">×</b></span>`).join('');
    let html = `<h3>Roots</h3>${chips || '<span class="dim">none</span>'}`;
    if (state.hidden.size) html += `<h3>Hidden · ${state.hidden.size} <button data-unhide="all">Show all</button></h3>`
      + [...state.hidden].map(h => `<span class="chip off">${esc(short(N[h]))} <b data-unhide="${h}">×</b></span>`).join('');
    html += mine;
    const id = state.selected;
    if (id == null) {
      html += `<p class="dim">Click a symbol to see who calls and uses it. Double-click it to make it the root. Shift adds a root.<br>Right-click or <b>h</b> hides a symbol. <b>e</b> shows all its neighbours.</p>`;
      if (!state.roots.size) {
        // With no root, offer the entry points, and the functions that nothing in the project calls.
        const tops = N.filter(n => n.cls === 'fn' && !n.ext && inProduct(n) && !inc[n.id].some(e => e.kind === 'calls' || e.kind === 'refs' || e.kind === 'dispatch') && out[n.id].length)
          .sort((a, b) => out[b.id].length - out[a.id].length).slice(0, 60);
        const entries = M.entries.filter(inProduct);
        if (state.product) html += `<p class="dim">The product ${esc(state.product)} has ${N.filter(inProduct).length} symbols${entries.length ? '' : ' and no marked entry point: pick a function below, or find one'}.</p>`;
        if (entries.length) html += `<h3>Entry points · ${entries.length}</h3>` + entries.map(n => rowHTML(n, esc(n.module)).replace('data-id', 'data-entry')).join('');
        html += `<h3>Functions with no caller · largest first</h3>` + tops.map(n => rowHTML(n, out[n.id].length + ' edges')).join('');
      }
    } else {
      const n = N[id];
      html += `<h3>${esc(n.kind)}${n.diff ? ` · <span class="dst d-${n.diff}">${FGDiff.LABEL[n.diff]}</span>` : ''}</h3><h2>${esc(n.name)}</h2><div class="dim">${esc(where(n))}</div>`;
      if (M.decl[id]) html += `<pre>${esc(M.decl[id])}</pre>`;
      if (M.doc[id]) html += `<div>${esc(M.doc[id])}</div>`;
      html += `<div class="actions"><button data-root="${id}">Make root</button><button data-add="${id}">Add as root</button>`
        + (drawn(id) ? `<button data-open="${id}">${state.open.has(id) ? 'Collapse neighbours' : 'Expand neighbours'}</button>` + (state.roots.has(id) ? '' : `<button data-hide="${id}">Hide</button>`)
          : `<button data-show="${id}">Show</button>`)
        + `<button data-mark="${esc(markKey(n))}">${state.marks.includes(markKey(n)) ? 'Unmark' : '▣ Mark for replacement'}</button>`
        + (n.module ? `<button data-mark="m:${esc(n.module)}">${state.marks.includes('m:' + n.module) ? 'Unmark' : '▣ Mark'} module ${esc(n.module)}</button>` : '') + `</div>`;
      if (n.label) html += `<div class="dim">An entry point: the project hands it to <code>${esc(n.label)}</code></div>`;
      const b = body(id);
      if (b) html += `<div class="dim">${[b.async && 'async', b.throws && 'throws'].filter(Boolean).join(' · ')}</div>`;
      if (kids[id].length) html += `<h3>Members · ${kids[id].length}</h3>` + kids[id].slice(0, 200).map(k => panelRow(N[k], `${inc[k].length} in · ${out[k].length} out`)).join('');
      html += list('— used by', inc[id], 'from') + list('— in its body, in source order', out[id], 'to');
    }
    $('side').innerHTML = html;
  }

  // --- a snapshot arrives
  function load(snapshot, name) {
    H = decode(snapshot); H.name = name || '';
    raw = snapshot; M = H; F = null;
    const v = M.view, p = M.project;
    Object.assign(state, { side: 'both', diffShow: 'all', roots: new Set(v.roots || []), up: v.up ?? 1, down: v.down ?? 2, off: new Set(), selected: null, product: '',
      group: v.group || 'file', data: !v.fnOnly, types: !v.fnOnly, ext: true, sys: false, hidden: new Set(), shown: new Set(), open: new Set() });
    $('title').textContent = p.name || 'flowgraph';
    document.title = (p.name || 'snapshot') + ' — flowgraph';
    $('source').textContent = [name, p.branch, p.commit && p.commit + (p.dirty ? ' + changes' : ''), p.staleFiles ? `index older than  source files` : ''].filter(Boolean).join(' · ');
    $('source').title = [p.created && 'snapshot made ' + p.created, p.indexed && 'index written ' + p.indexed].filter(Boolean).join('\n');
    $('kinds').innerHTML = M.edgeKinds.map(k => `<label><input type="checkbox" data-kind="${k}" checked><span style="color:${EDGE_COLOR[k]}">${k}</span></label>`).join(' ');
    $('product').innerHTML = '<option value="">all</option>' + M.products.map(q => `<option value="${esc(q.name)}">${esc(q.name)} · ${esc(q.type)}</option>`).join('');
    $('productbox').style.display = M.products.length ? '' : 'none';
    $('entry').innerHTML = '<option value="">…</option>' + M.entries.map(n => `<option value="${n.id}">${esc(n.module)} · ${esc(short(n))}</option>`).join('');
    $('entrybox').style.display = M.entries.length ? '' : 'none';
    $('extbox').style.display = M.N.some(n => n.ext && !n.sys) ? '' : 'none';
    $('sysbox').style.display = M.N.some(n => n.sys) ? '' : 'none';
    // A link can set the first view: page.html?group=none&down=3&data=0#Type.member&otherFunction
    for (const k of ['up', 'down']) if (params.has(k)) state[k] = +params.get(k);
    for (const k of ['data', 'types', 'ext', 'sys']) if (params.has(k)) state[k] = params.get(k) !== '0';
    if (params.has('group')) state.group = params.get('group');
    if (location.hash.length > 1) {
      const names = location.hash.slice(1).split('&').map(decodeURIComponent);
      const found = names.map(q => M.N.find(n => n.name === q) || M.N.find(n => n.name.split('(')[0] === q)).filter(Boolean);
      if (found.length) state.roots = new Set(found.map(n => n.id));
    }
    state.product = params.get('product') ?? v.product ?? '';
    if (state.product && !state.roots.size) state.roots = new Set(M.entries.filter(inProduct).map(n => n.id));
    state.selected = state.roots.size === 1 ? [...state.roots][0] : null;
    // The marks come from the last visit of this project, or else from the flowgraph.json of the project.
    let marks = null;
    try { marks = JSON.parse(localStorage.getItem(storeKey())); } catch (e) { /* no storage */ }
    if (!Array.isArray(marks)) {
      const modules = new Set(M.N.map(n => n.module));
      marks = M.replace.flatMap(r => modules.has(r) ? ['m:' + r] : M.N.filter(n => n.name === r || n.module + '.' + n.name.split('(')[0] === r).map(markKey));
    }
    state.marks = marks;
    applyMarks();
    for (const view of views) if (view.mounted && view.reset) view.reset();
    $('open').classList.remove('on');
    // A base that was chosen stays: the new snapshot is compared with it.
    if (baseModel) rebase(true);
    refresh();
    // A hosted page can name the base in its link: ?snapshot=head.json&base=main.json
    if (!linked && params.has('base')) {
      linked = true;
      const url = params.get('base');
      fetch(url).then(r => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json(); }).then(s => setBase(s, url.split('/').pop())).catch(e => status(`${url}: ${e.message}`, true));
    }
  }
  async function openFile(file) {
    $('openerror').textContent = '';
    try { load(JSON.parse(await file.text()), file.name); }
    catch (e) { $('open').classList.add('on'); $('openerror').textContent = `${file.name}: ${e.message}`; }
  }

  /** Called once, after every view registered. `snapshot` is the snapshot inside the page, or null. */
  function start(snapshot) {
    for (const v of views) {
      v.box = document.createElement('div'); v.box.className = 'viewbox'; $('views').appendChild(v.box);
      v.tab = document.createElement('button'); v.tab.textContent = v.title; v.tab.onclick = () => activate(v.id); $('tabs').appendChild(v.tab);
    }
    for (const id of ['up', 'down']) {
      $(id).innerHTML = [0, 1, 2, 3, 4, 6, 8, -1].map(d => `<option value="${d}">${d < 0 ? 'max' : d}</option>`).join('');
      $(id).onchange = () => { state[id] = +$(id).value; refresh(); };
    }
    $('group').onchange = () => { state.group = $('group').value; refresh(); };
    for (const id of ['data', 'types', 'ext', 'sys']) $(id).onchange = () => { state[id] = $(id).checked; refresh(); };
    $('kinds').onchange = ev => { const k = ev.target.dataset.kind; ev.target.checked ? state.off.delete(k) : state.off.add(k); refresh(); };
    $('product').onchange = () => setProduct($('product').value);
    $('entry').onchange = () => { if ($('entry').value) setEntry(+$('entry').value); };
    $('search').oninput = showHits;
    $('search').onkeydown = ev => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        hitIndex = Math.max(0, Math.min(hitList.length - 1, hitIndex + (ev.key === 'ArrowDown' ? 1 : -1)));
        [...$('hits').children].forEach((c, i) => c.classList.toggle('on', i === hitIndex));
        $('hits').children[hitIndex]?.scrollIntoView({ block: 'nearest' });
        ev.preventDefault();
      } else if (ev.key === 'Enter' && hitList[hitIndex]) setRoot(hitList[hitIndex].id, ev.shiftKey);
      else if (ev.key === 'Escape') { $('hits').style.display = 'none'; $('search').blur(); }
    };
    $('hits').onmousedown = ev => { const r = ev.target.closest('.row'); if (r) setRoot(+r.dataset.id, ev.shiftKey); };
    document.addEventListener('keydown', ev => {
      if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (ev.key === '/') { $('search').focus(); $('search').select(); ev.preventDefault(); }
      else if (state.selected != null && (ev.key === 'h' || ev.key === 'Backspace' || ev.key === 'Delete')) hide(state.selected);
      else if (state.selected != null && ev.key === 'e') toggleOpen(state.selected);
    });
    document.addEventListener('mousedown', ev => { if (!ev.target.closest('#searchbox')) $('hits').style.display = 'none'; });
    $('diffbutton').onclick = () => { if (F) activate('diff'); else $('basefile').click(); };
    $('basefile').onchange = async () => {
      const file = $('basefile').files[0];
      $('basefile').value = '';
      if (!file) return;
      try { setBase(JSON.parse(await file.text()), file.name); } catch (e) { status(`${file.name}: ${e.message}`, true); }
    };
    $('diffinfo').onclick = ev => { const d = ev.target.dataset.diff; if (d === 'swap') swapDiff(); else if (d === 'off') setBase(null, ''); };
    $('diffinfo').onchange = ev => {
      const d = ev.target.dataset.diff;
      if (d === 'side') setSide(ev.target.value);
      else if (d === 'show') { state.diffShow = ev.target.value; refresh(); }
    };
    $('marks').onclick = ev => { if (ev.target.dataset.unmark) toggleMark(ev.target.dataset.unmark); };
    $('side').onclick = ev => {
      const t = ev.target;
      if (active.panelClick && active.panelClick(ev)) return;
      if (t.dataset.mark) toggleMark(t.dataset.mark);
      else if (t.dataset.drop) { state.roots.delete(+t.dataset.drop); refresh(); }
      else if (t.closest('[data-entry]')) setEntry(+t.closest('[data-entry]').dataset.entry);
      else if (t.dataset.sw) { const id = +t.dataset.sw; drawn(id) ? hide(id) : show(id); }
      else if (t.dataset.unhide === 'all') { state.hidden.clear(); refresh(); }
      else if (t.dataset.unhide) restore(+t.dataset.unhide);
      else if (t.dataset.hide) hide(+t.dataset.hide);
      else if (t.dataset.show) show(+t.dataset.show);
      else if (t.dataset.open) toggleOpen(+t.dataset.open);
      else if (t.dataset.root) setRoot(+t.dataset.root, false);
      else if (t.dataset.add) setRoot(+t.dataset.add, true);
      else { const r = t.closest('.row') || t.closest('.exit[data-id]'); if (r) select(+r.dataset.id, null); }
    };
    // A snapshot comes from inside the page, from a file that the user chooses or drops, or from a link when the page is hosted.
    $('openbutton').onclick = $('openbutton2').onclick = () => $('openfile').click();
    $('openfile').onchange = () => { if ($('openfile').files[0]) openFile($('openfile').files[0]); $('openfile').value = ''; };
    document.addEventListener('dragover', ev => { ev.preventDefault(); $('open').classList.add('over'); });
    document.addEventListener('dragleave', () => $('open').classList.remove('over'));
    document.addEventListener('drop', ev => { ev.preventDefault(); $('open').classList.remove('over'); if (ev.dataTransfer.files[0]) openFile(ev.dataTransfer.files[0]); });
    active = views.find(v => v.id === params.get('view')) || views[0];
    for (const v of views) { v.box.classList.toggle('on', v === active); v.tab.classList.toggle('on', v === active); }
    if (snapshot) load(snapshot, '');
    else if (params.has('snapshot')) {
      const url = params.get('snapshot');
      status(`loading ${url}…`);
      fetch(url).then(r => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json(); }).then(s => load(s, url.split('/').pop()))
        .catch(e => { status(''); $('open').classList.add('on'); $('openerror').textContent = `${url}: ${e.message}`; });
    } else $('open').classList.add('on');
  }

  return { registerView, start, load, refresh, status, select, setRoot, setEntry, setProduct, hide, show, toggleOpen, restore,
    state, params, views, esc, short, where, productsOf, inProduct, allowed, EDGE_COLOR, body, exits, isMarked, toggleMark, markedBelow,
    activate, setBase, setSide, swapDiff,
    /** The snapshot of the page as it was read. */ get raw() { return raw; },
    /** With a base chosen: the merged model of both snapshots, with the counts of each state. Else null. */ get diff() { return F; },
    /** @returns {?Model} */ get model() { return M; },
    /** @returns {Scope} */ get scope() { return scope; } };
})();
