import Foundation
import IndexStore

struct Node {
  var usr: String
  var name: String
  var kind: String
  var file = -1
  var line = 0
  var module = ""
  var parent = -1
  var isDefinition = false
  var external = true
  var system = false
  /// The source marks it as an entry point: `@_cdecl`, `@c`, `@main`, or a C `main`. Or the project hands it to code of another module.
  var entry = false
  /// True when the index holds the declaration, so the module is known and not a guess.
  var declared = false
  /// For an entry point that the project hands to another module: the call that takes it.
  var label = ""
}

struct Place: Hashable {
  var file: Int
  var line: Int
  var column: Int
}

struct EdgeKey: Hashable {
  var from: Int
  var to: Int
  var kind: Int
}

struct Site: Hashable {
  var key: EdgeKey
  var file: Int
  var line: Int
  var column: Int
}

let edgeKinds = ["calls", "refs", "reads", "writes", "uses", "inherits", "dispatch"]

struct Graph {
  var nodes: [Node] = []
  var files: [String] = []
  var edges: [EdgeKey: (count: Int, line: Int)] = [:]

  private var ids: [String: Int] = [:]
  private var fileIds: [String: Int] = [:]
  private var sites: [Int: Set<Site>] = [:]
  private var places: [Place: Int] = [:]
  /// For each node that `read` made, the node that holds it after `finish` and `cone`, or -1.
  private(set) var finalId: [Int] = []
  /// An accessor is drawn as its property, and an extension as the type that it extends.
  private var alias: [Int: Int] = [:]
  private var parents: [Int: Int] = [:]
  private var skipped = Set<String>()
  /// The macros whose text exports a symbol from its binary, and the lines that use a macro.
  private var exportMacros = Set<String>()
  private var macroUses: [Place: Set<String>] = [:]
  /// The C functions that are defined with the text of an export on their line.
  private var exportedByText = Set<Int>()
  private static let exportMarks = ["visibility(\"default\")", "visibility (\"default\")", "dllexport"]
  /// For a C name that more than one module defines, the modules that define it.
  var owners: [String: Set<String>] = [:]
  /// For each compilation, the modules that it reads: a use from Swift lands on the definition of the module that the code imports.
  var sees: [String: Set<String>] = [:]

  /// A C name has no module in its USR. Two binaries that each define the same name then share one USR,
  /// and so do two Swift modules that each export it (`@_cdecl`). The module is part of the key then.
  private mutating func id(_ s: Sym, in context: String) -> Int? {
    var key = s.usr
    if let own = owners[s.usr] {
      if own.contains(context) {
        key += "@" + context
      } else if own.count == 1 {
        key += "@" + own.first!
      } else {
        let seen = own.intersection(sees[context] ?? [])
        if seen.count == 1 { key += "@" + seen.first! }
      }
    }
    if let i = ids[key] {
      // A struct that has only the name of its typedef has no name in some records.
      if nodes[i].name.isEmpty, !s.name.isEmpty { nodes[i].name = s.name }
      return i
    }
    if skipped.contains(s.usr) { return nil }
    if s.skipped {
      skipped.insert(s.usr)
      return nil
    }
    ids[key] = nodes.count
    nodes.append(Node(usr: key, name: s.name, kind: s.kind))
    return nodes.count - 1
  }

  private mutating func fileId(_ path: String) -> Int {
    if let i = fileIds[path] { return i }
    fileIds[path] = files.count
    files.append(path)
    return files.count - 1
  }

  private mutating func add(_ from: Int, _ to: Int, _ kind: String, _ file: Int, _ occ: Occ) {
    let key = EdgeKey(from: from, to: to, kind: edgeKinds.firstIndex(of: kind)!)
    sites[file, default: []].insert(Site(key: key, file: file, line: occ.line, column: occ.column))
  }

  /// Reads each occurrence of one record of a source file: a definition makes a node, a use makes an edge.
  mutating func read(_ reading: Reading, relativeTo project: String, textAt text: String, from store: RawStore) {
    let path = reading.file
    let lines = (try? String(contentsOfFile: text, encoding: .utf8))?.split(separator: "\n", omittingEmptySubsequences: false) ?? []
    let shown = path.hasPrefix(project + "/") ? String(path.dropFirst(project.count + 1)) : path
    let module = reading.context
    var all: [Occ] = []
    store.forEachOccurrence(of: reading.record) { all.append($0) }
    for occ in all {
      let roles = occ.roles
      let declares = roles.contains(.definition) || roles.contains(.declaration)
      // The declaration of a name that other binaries define, in a header that this binary only reads, is no symbol of its own.
      if declares, !roles.contains(.definition), let own = owners[occ.sym.usr], own.count > 1, !own.contains(module) { continue }
      if occ.sym.kind == "macro" {
        // A macro can hold the attribute that exports a function from its binary. The line that uses it is kept.
        let text = occ.line >= 1 && occ.line <= lines.count ? lines[occ.line - 1] : ""
        if roles.contains(.definition) {
          if Graph.exportMarks.contains(where: text.contains) { exportMacros.insert(occ.sym.usr) }
        } else if roles.contains(.reference) {
          macroUses[Place(file: fileId(shown), line: occ.line, column: 0), default: []].insert(occ.sym.usr)
        }
      }
      guard let sym = id(occ.sym, in: module) else { continue }
      if declares {
        let isDefinition = roles.contains(.definition)
        if !nodes[sym].isDefinition {
          // Swift sees a C field as a property. The place that declares the symbol says what it is.
          nodes[sym].kind = occ.sym.kind
          nodes[sym].file = fileId(shown)
          nodes[sym].line = occ.line
          nodes[sym].module = reading.module
          nodes[sym].isDefinition = isDefinition
          nodes[sym].external = false
          nodes[sym].entry = isDefinition && Graph.isEntry(occ.sym, line: occ.line, in: lines)
          if isDefinition, !occ.sym.swift, occ.sym.kind == "function", occ.line >= 1, occ.line <= lines.count {
            // The attribute is on the line of the name, or on the line above it.
            let above = occ.line >= 2 ? lines[occ.line - 2] : ""
            if Graph.exportMarks.contains(where: { lines[occ.line - 1].contains($0) || above.contains($0) }) { exportedByText.insert(sym) }
          }
        }
        if isDefinition { places[Place(file: fileId(shown), line: occ.line, column: occ.column)] = sym }
        for r in occ.relations {
          guard let other = id(r.sym, in: module) else { continue }
          if r.roles.contains(.accessorOf) { alias[sym] = other }
          if r.roles.contains(.childOf), parents[sym] == nil { parents[sym] = other }
          // The implementation of a requirement, or the override of a method: a call of the base can land here.
          if r.roles.contains(.overrideOf) { add(other, sym, "dispatch", fileId(shown), occ) }
        }
        continue
      }
      guard roles.contains(.reference) || roles.contains(.call) else { continue }
      let file = fileId(shown)
      for r in occ.relations {
        guard let other = id(r.sym, in: module) else { continue }
        if r.roles.contains(.extendedBy) { alias[other] = sym }
        if r.roles.contains(.baseOf) { add(other, sym, "inherits", file, occ) }
      }
      let isCall = roles.contains(.call)
      let wanted: IndexStoreSymbolRoles = isCall ? .calledBy : .containedBy
      let from: Int
      if let user = occ.relations.first(where: { $0.roles.contains(wanted) }) {
        guard let found = id(user.sym, in: module) else { continue }
        from = found
      } else if path.hasSuffix("/main.swift") {
        // The top-level code of main.swift has no declaration, so it gets a node of its own: the entry point of the executable.
        let key = "toplevel:" + shown
        if ids[key] == nil {
          ids[key] = nodes.count
          nodes.append(Node(usr: key, name: "main.swift", kind: "function", file: file, line: 1, module: reading.module, isDefinition: true, external: false, entry: true))
        }
        from = ids[key]!
      } else {
        continue
      }
      let kind: String
      let sub = occ.sym.sub
      if isCall, sub == .accessorSetter || sub == .swiftAccessorWillSet || sub == .swiftAccessorDidSet || sub == .swiftAccessorMutableAddressor {
        kind = "writes"
      } else if isCall, sub == .accessorGetter || sub == .swiftAccessorAddressor {
        kind = "reads"
      } else if isCall {
        kind = "calls"
      } else if occ.sym.isData {
        kind = roles.contains(.write) ? "writes" : "reads"
      } else if occ.sym.isCallable {
        kind = "refs"
      } else {
        kind = "uses"
      }
      add(from, sym, kind, file, occ)
    }
  }

  // --- what the reader of the bodies needs, between `read` and `finish`

  func fileIndex(_ shown: String) -> Int? { fileIds[shown] }
  func definition(at place: Place) -> Int? { places[place] }
  func topLevel(of shown: String) -> Int? { ids["toplevel:" + shown] }
  /// They are in the order of the source, so that two snapshots of the same code are the same.
  func uses(in file: Int) -> [Site] {
    (sites[file] ?? []).sorted { a, b in
      (a.line, a.column, a.key.kind, nodes[a.key.to].usr) < (b.line, b.column, b.key.kind, nodes[b.key.to].usr)
    }
  }

  /// True for a function of another module that is not the standard library: code that the project hands a callback to.
  func takesHandOff(_ id: Int) -> Bool {
    let n = nodes[id]
    return n.external && n.declared && !n.system && n.module != "Swift" && !n.module.hasPrefix("_")
  }

  /// The module of each symbol of another module: from its declaration in the index, or else from its mangled name.
  mutating func nameExternals(from store: RawStore) {
    // The type that holds a member comes into the list while the loop runs, and gets its module in a later turn.
    var i = -1
    while i + 1 < nodes.count {
      i += 1
      guard nodes[i].external, nodes[i].module.isEmpty else { continue }
      let usr = nodes[i].usr
      let found = store.declaration(of: usr)
      var module = found?.module ?? ""
      let system = found?.system ?? false
      // A member of a type of another module is named with its type, as a member of the project is.
      if let holder = found?.holder, parents[i] == nil, let parent = id(holder, in: module), parent != i { parents[i] = parent }
      nodes[i].declared = !module.isEmpty
      nodes[i].system = system
      if module.isEmpty {
        if usr.hasPrefix("c:") || usr.hasPrefix("s:So") || usr.hasPrefix("s:SC") {
          module = "C"
        } else if usr.hasPrefix("s:") {
          // A mangled Swift name starts with the length and the name of its module. The standard library has short forms.
          let rest = usr.dropFirst(2)
          let digits = rest.prefix { $0.isNumber }
          if let length = Int(digits), rest.count >= digits.count + length {
            module = String(rest.dropFirst(digits.count).prefix(length))
          } else if rest.first == "S" || rest.first == "s" {
            module = "Swift"
          }
        }
      }
      nodes[i].module = module
      // On Linux the index names the parts of the standard library: Swift.String, Swift.Collection.Array.
      if module.hasPrefix("Swift.") { module = "Swift" }
      if module == "Swift" || module.hasPrefix("_") { nodes[i].system = true }
    }
  }

  /// A closure that the project hands to another module becomes a node, and an entry point.
  mutating func addClosure(label: String, file: Int, line: Int, owner: Int) -> Int {
    // The key has no line, so that a snapshot of changed code gives the same closure the same key.
    var key = "closure:\(nodes[owner].usr):\(label)"
    var n = 2
    while ids[key] != nil {
      key = "closure:\(nodes[owner].usr):\(label)#\(n)"
      n += 1
    }
    ids[key] = nodes.count
    nodes.append(Node(usr: key, name: label + " { }", kind: "closure", file: file, line: line, module: nodes[owner].module, isDefinition: true, external: false, entry: true, label: label))
    let edge = EdgeKey(from: owner, to: nodes.count - 1, kind: edgeKinds.firstIndex(of: "refs")!)
    sites[file, default: []].insert(Site(key: edge, file: file, line: line, column: 0))
    return nodes.count - 1
  }

  mutating func unmarkEntry(_ id: Int) { nodes[id].entry = false }

  mutating func markEntry(_ id: Int, label: String) {
    let target = resolved(id)
    nodes[target].entry = true
    if nodes[target].label.isEmpty { nodes[target].label = label }
  }

  /// The uses inside a closure that became a node leave the function that holds the closure, and belong to the closure.
  mutating func move(usesIn file: Int, to owner: (Site) -> Int?) {
    guard let old = sites[file] else { return }
    let structural = edgeKinds.firstIndex(of: "inherits")!
    sites[file] = Set(old.map { site in
      guard site.key.kind < structural, site.column > 0, let id = owner(site) else { return site }
      var moved = site
      moved.key.from = id
      return moved
    })
  }

  /// The attributes of a declaration are on its line or on the lines above it, among the comments.
  private static func isEntry(_ s: Sym, line: Int, in lines: [Substring]) -> Bool {
    // A C `main`, or the static `main()` of a type with `@main`. A free Swift function named main is not one.
    if s.name == "main", s.kind == "function", !s.swift { return true }
    guard s.swift, s.isCallable || s.kind == "struct" || s.kind == "class" || s.kind == "enum" else { return false }
    guard line >= 1, line <= lines.count else { return false }
    let marks = ["@_cdecl(", "@c(", "@c ", "@main", "@UIApplicationMain", "@NSApplicationMain", "@_silgen_name("]
    var i = line - 1
    while i >= 0 {
      let text = lines[i].trimmingCharacters(in: .whitespaces)
      if !text.hasPrefix("//"), marks.contains(where: text.contains) { return true }
      if i < line - 1, !(text.hasPrefix("@") || text.hasPrefix("//")) { break }
      i -= 1
    }
    return false
  }

  private func resolved(_ i: Int) -> Int {
    var i = i
    var steps = 0
    while let next = alias[i], steps < 8 {
      i = next
      steps += 1
    }
    return i
  }

  /// Folds the aliases, drops what is not wanted, and gives each node its full name.
  mutating func finish(keepExternal: Bool, allows: (Node) -> Bool = { _ in true }) {
    linkAssignments()
    for (child, parent) in parents { nodes[child].parent = resolved(parent) }
    var merged: [EdgeKey: (count: Int, line: Int)] = [:]
    finalId = nodes.indices.map(resolved)
    for s in sites.values.joined() {
      // The getter of a property of another module has no declaration in the index. The use of the property itself is one more site.
      if alias[s.key.to] == nil, nodes[s.key.to].external, nodes[s.key.to].name.hasPrefix("getter:") || nodes[s.key.to].name.hasPrefix("setter:") { continue }
      let key = EdgeKey(from: resolved(s.key.from), to: resolved(s.key.to), kind: s.key.kind)
      // A property that reads itself through its accessor says nothing.
      if key.from == key.to, s.key.from != s.key.to { continue }
      if nodes[key.from].external { continue }
      if nodes[key.to].external, !keepExternal { continue }
      let old = merged[key]
      merged[key] = ((old?.count ?? 0) + 1, min(old?.line ?? .max, s.line))
    }
    sites.removeAll()
    // A field or a variable that the code calls holds a function. It is drawn with the functions, so that a path can go through it.
    let calls = edgeKinds.firstIndex(of: "calls")!
    for key in merged.keys where key.from != key.to {
      if key.kind == calls, nodes[key.to].kind == "field" { nodes[key.to].kind = "functionField" }
      if key.kind == calls, nodes[key.to].kind == "variable" { nodes[key.to].kind = "functionVariable" }
    }
    // A C function that its binary exports is called from outside: it is an entry point.
    for i in nodes.indices where nodes[i].isDefinition && !nodes[i].external && nodes[i].kind == "function" && alias[i] == nil && nodes[i].usr.hasPrefix("c:") {
      var exported = exportedByText.contains(i)
      for line in [nodes[i].line, nodes[i].line - 1] where !exported {
        exported = !(macroUses[Place(file: nodes[i].file, line: line, column: 0)] ?? []).isDisjoint(with: exportMacros)
      }
      if exported, allows(nodes[i]) { nodes[i].entry = true }
    }
    exportMacros = []
    macroUses = [:]
    // A macro that no symbol uses says nothing in a graph, and neither does a symbol of another module.
    var used = Set<Int>()
    for key in merged.keys {
      used.insert(key.from)
      used.insert(key.to)
    }
    let aliased = Set(alias.keys)
    keep(merged) { i, node in !aliased.contains(i) && (node.external || node.kind == "macro" ? used.contains(i) : true) }
    var full: [String] = nodes.map(\.name)
    for i in nodes.indices {
      var chain: [String] = []
      var p = nodes[i].parent
      while p >= 0, chain.count < 8 {
        chain.append(nodes[p].name)
        p = nodes[p].parent
      }
      if !chain.isEmpty { full[i] = (chain.reversed() + [nodes[i].name]).joined(separator: ".") }
    }
    for i in nodes.indices { nodes[i].name = full[i] }
  }

  /// A table of functions: one statement writes a field or a variable and names a function, and other code calls the field.
  /// The field then leads to the function, as a requirement leads to its implementation.
  /// The index has no statements, so the link is read from one line: a write, and after it the name of a function, in one function.
  /// A call between the two ends the link: the function is then an argument of the call, and the field holds the result.
  private mutating func linkAssignments() {
    let writes = edgeKinds.firstIndex(of: "writes")!, refs = edgeKinds.firstIndex(of: "refs")!
    let calls = edgeKinds.firstIndex(of: "calls")!, dispatch = edgeKinds.firstIndex(of: "dispatch")!
    struct Line: Hashable { var from: Int; var file: Int; var line: Int }
    var byLine: [Line: [Site]] = [:]
    for s in sites.values.joined() where s.key.kind == writes || s.key.kind == refs || s.key.kind == calls {
      byLine[Line(from: s.key.from, file: s.file, line: s.line), default: []].append(s)
    }
    for (_, found) in byLine where found.count > 1 {
      let ordered = found.sorted { ($0.column, $0.key.kind) < ($1.column, $1.key.kind) }
      var target: Site?
      for s in ordered {
        if s.key.kind == writes {
          target = s
        } else if s.key.kind == calls {
          target = nil
        } else if let t = target, t.key.to != s.key.to {
          sites[s.file, default: []].insert(Site(key: EdgeKey(from: t.key.to, to: s.key.to, kind: dispatch), file: s.file, line: s.line, column: s.column))
        }
      }
    }
  }

  /// Keeps only what the roots reach: their callers and users upward, and what they call and use downward.
  mutating func cone(of roots: [Int]) {
    var outgoing: [Int: [Int]] = [:]
    var incoming: [Int: [Int]] = [:]
    for key in edges.keys {
      outgoing[key.from, default: []].append(key.to)
      incoming[key.to, default: []].append(key.from)
    }
    func reach(_ next: [Int: [Int]]) -> Set<Int> {
      var seen = Set(roots)
      var queue = roots
      while let n = queue.popLast() {
        for m in next[n] ?? [] where seen.insert(m).inserted { queue.append(m) }
      }
      return seen
    }
    let kept = reach(outgoing).union(reach(incoming))
    keep(edges) { i, _ in kept.contains(i) }
  }

  private mutating func keep(_ candidates: [EdgeKey: (count: Int, line: Int)], where wanted: (Int, Node) -> Bool) {
    var map = [Int](repeating: -1, count: nodes.count)
    var kept: [Node] = []
    for (i, node) in nodes.enumerated() where wanted(i, node) {
      map[i] = kept.count
      kept.append(node)
    }
    for i in kept.indices where kept[i].parent >= 0 { kept[i].parent = map[kept[i].parent] }
    finalId = finalId.map { $0 >= 0 ? map[$0] : -1 }
    places = [:]
    nodes = kept
    ids = Dictionary(uniqueKeysWithValues: kept.enumerated().map { ($1.usr, $0) })
    edges = [:]
    for (key, value) in candidates where map[key.from] >= 0 && map[key.to] >= 0 {
      edges[EdgeKey(from: map[key.from], to: map[key.to], kind: key.kind)] = value
    }
    alias = [:]
    parents = [:]
  }

  /// The nodes that a `--root` argument names: a USR, a full name, or a name with no argument labels.
  func find(_ root: String) -> [Int] {
    if let i = ids[root] { return [i] }
    func base(_ s: String) -> Substring { s.prefix { $0 != "(" } }
    let exact = nodes.indices.filter { nodes[$0].name == root }
    if !exact.isEmpty { return exact }
    // An entry point that the project hands to another module is found by the call that takes it: get("users")
    let labelled = nodes.indices.filter { !nodes[$0].label.isEmpty && nodes[$0].label == root }
    if !labelled.isEmpty { return labelled }
    // Two modules can hold the same name, so a name can lead with its module: Module.name
    let qualified = nodes.indices.filter { !nodes[$0].external && nodes[$0].module + "." + base(nodes[$0].name) == root }
    if !qualified.isEmpty { return qualified }
    let byBase = nodes.indices.filter { !nodes[$0].external && base(nodes[$0].name) == root }
    if !byBase.isEmpty { return byBase }
    return nodes.indices.filter { !nodes[$0].external && base(nodes[$0].name).hasSuffix("." + root) }
  }

  func index(ofUSR usr: String) -> Int? { ids[usr] }
}
