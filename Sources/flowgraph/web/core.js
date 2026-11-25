'use strict';
// The core of the page. It holds the snapshot that is open and the base of a diff, the state that all views share,
// and the scope: the part of the graph that the roots reach. A view is one file that calls FG.registerView.

/**
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

  const where = n => n.file >= 0 ? `${M.files[n.file]}:${n.line}` : (n.module || 'other module');
  const row = (n, extra = '') => `<div class="row" data-id="${n.id}"><span class="dot ${n.cls}"></span><span>${esc(n.name)}</span><span class="where">${extra || esc(where(n))}</span></div>`;
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

  // With a base chosen, the body of a symbol is the two bodies as one outline, and its ways out are those of both.
  const body = id => M.merged ? M.body(id) : FGModel.bodyIn(M, id), exits = id => M.merged ? M.exits(id) : FGModel.exitsIn(M, id);
  // H: the snapshot of the page. F: H merged with the base of a diff, or null. M is what the views read: H, or one side of F.
  let H = null, F = null, raw = null, baseModel = null, baseRaw = null, baseName = '', linked = false;

  // --- the marks for replacement
  let markedIds = new Set();
  const isMarked = id => markedIds.has(id);
  const markKey = n => 'u:' + n.usr;
  const storeKey = () => 'flowgraph.marks.' + (M.project.name || '');
  function applyMarks() {
    markedIds = new Set();
    const modules = new Set(state.marks.filter(k => k[0] === 'm').map(k => k.slice(2))), usrs = new Set(state.marks.filter(k => k[0] === 'u').map(k => k.slice(2)));
    const add = id => { if (markedIds.has(id)) return; markedIds.add(id); for (const k of M.kids[id]) add(k); };
    for (const n of M.N) if (modules.has(n.module) || usrs.has(n.usr)) add(n.id);
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
    baseModel = snapshot ? FGModel.decode(snapshot) : null;
    if (baseModel) baseModel.name = baseName;
    rebase(true);
    if (snapshot) FGLibrary.hide();
    refresh();
  }
  const chooseBase = () => FGLibrary.show('Choose the base of the comparison: the button Base of a snapshot.');
  function rebase(narrow) {
    F = baseModel ? FGDiff.merge(H, baseModel) : null;
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

  function status(text, warn) { $('status').className = warn ? 'warn' : ''; $('status').textContent = text; }

  /** Works the scope out again and gives it to the view that is shown. Call it after each change of the state. */
  function refresh() {
    if (!M || !active) return;
    FGToolbar.sync();
    scope = reach();
    if (!active.mounted) { active.mount(active.box, $('viewbar')); active.mounted = true; }
    active.update(scope);
    FGPanel.render();
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
    FGPanel.render();
  }
  function setRoot(id, add) {
    if (!add) state.roots.clear();
    state.roots.add(id);
    state.selected = id;
    FGToolbar.closeSearch();
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

  // --- a snapshot arrives
  function load(snapshot, name) {
    H = FGModel.decode(snapshot); H.name = name || '';
    raw = snapshot; M = H; F = null;
    const v = M.view;
    Object.assign(state, { side: 'both', diffShow: 'all', roots: new Set(v.roots || []), up: v.up ?? 1, down: v.down ?? 2, off: new Set(), selected: null, product: '',
      group: v.group || 'file', data: !v.fnOnly, types: !v.fnOnly, ext: true, sys: false, hidden: new Set(), shown: new Set(), open: new Set() });
    FGToolbar.loaded();
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
    FGLibrary.hide();
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

  /** Called once, after every view registered. `snapshot` is the snapshot inside the page, or null. */
  function start(snapshot) {
    for (const v of views) {
      v.box = document.createElement('div'); v.box.className = 'viewbox'; $('views').appendChild(v.box);
      v.tab = document.createElement('button'); v.tab.textContent = v.title; v.tab.onclick = () => activate(v.id); $('tabs').appendChild(v.tab);
    }
    FGToolbar.mount(); FGPanel.mount(); FGLibrary.mount();
    active = views.find(v => v.id === params.get('view')) || views[0];
    for (const v of views) { v.box.classList.toggle('on', v === active); v.tab.classList.toggle('on', v === active); }
    if (snapshot) load(snapshot, '');
    else if (params.has('snapshot')) {
      const url = params.get('snapshot');
      status(`loading ${url}…`);
      fetch(url).then(r => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json(); }).then(s => load(s, url.split('/').pop()))
        .catch(e => { status(''); FGLibrary.show(`${url}: ${e.message}`, true); });
    } else FGLibrary.show();
  }

  return { registerView, start, load, refresh, status, select, setRoot, setEntry, setProduct, hide, show, toggleOpen, restore,
    state, params, views, esc, short, where, row, productsOf, inProduct, allowed, EDGE_COLOR, body, exits, isMarked, markKey, toggleMark, markedBelow,
    activate, setBase, chooseBase, setSide, swapDiff,
    /** The view that is shown. @returns {?View} */ get active() { return active; },
    /** The snapshots that are open, each as it was read and with its name: the head, and the base of a diff. */
    get loaded() { return { head: raw && { snapshot: raw, name: H.name }, base: baseRaw && { snapshot: baseRaw, name: baseName } }; },
    /** With a base chosen: the merged model of both snapshots, with the counts of each state. Else null. */ get diff() { return F; },
    /** @returns {?Model} */ get model() { return M; },
    /** @returns {Scope} */ get scope() { return scope; } };
})();
