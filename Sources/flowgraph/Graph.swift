import Foundation
import IndexStoreDB

/// One declaration of the project, or of another module when `--external` is set.
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
  /// True for a symbol of the SDK or of the toolchain.
  var system = false
  /// The source marks it as an entry point: `@_cdecl`, `@c`, `@main`, or a C `main`. Or the project hands it to code of another module.
  var entry = false
  /// True when the index holds the declaration, so the module is known and not a guess.
  var declared = false
  /// For an entry point that the project hands to another module: the call that takes it.
  var label = ""
}

/// The place of a definition: the file, and the line and the column of its name.
struct Place: Hashable {
  var file: Int
  var line: Int
  var column: Int
}

/// One relation between two symbols, with the count of the places where it occurs.
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
  private var cKeys = Set<String>()

  /// A Swift function with a C name (`@_cdecl`) has the USR of that C name.
  /// Two modules that each export the same C name then share one USR, so the module is part of the key.
  private mutating func id(_ s: Symbol, in module: String) -> Int? {
    let key = s.language == .swift && s.usr.hasPrefix("c:") ? s.usr + "@" + module : s.usr
    if let i = ids[key] { return i }
    if key != s.usr { cKeys.insert(key) }
    if skipped.contains(s.usr) { return nil }
    if s.kind == .parameter || s.kind == .commentTag || s.kind == .module || s.properties.contains(.local)
      || s.subKind == .swiftGenericTypeParam
    {
      skipped.insert(s.usr)
      return nil
    }
    ids[key] = nodes.count
    nodes.append(Node(usr: key, name: s.name, kind: "\(s.kind)"))
    return nodes.count - 1
  }

  private mutating func fileId(_ path: String) -> Int {
    if let i = fileIds[path] { return i }
    fileIds[path] = files.count
    files.append(path)
    return files.count - 1
  }

  private static func isData(_ k: IndexSymbolKind) -> Bool {
    switch k {
    case .variable, .field, .enumConstant, .instanceProperty, .classProperty, .staticProperty: return true
    default: return false
    }
  }

  private static func isCallable(_ k: IndexSymbolKind) -> Bool {
    switch k {
    case .function, .instanceMethod, .classMethod, .staticMethod, .constructor, .destructor, .conversionFunction:
      return true
    default: return false
    }
  }

  private mutating func add(_ from: Int, _ to: Int, _ kind: String, _ file: Int, _ loc: SymbolLocation) {
    let key = EdgeKey(from: from, to: to, kind: edgeKinds.firstIndex(of: kind)!)
    sites[file, default: []].insert(Site(key: key, file: file, line: loc.line, column: loc.utf8Column))
  }

  /// Reads each occurrence of one source file: a definition makes a node, a use makes an edge.
  mutating func read(file path: String, relativeTo project: String, from db: IndexStoreDB) {
    let lines = (try? String(contentsOfFile: path, encoding: .utf8))?.split(separator: "\n", omittingEmptySubsequences: false) ?? []
    let shown = path.hasPrefix(project + "/") ? String(path.dropFirst(project.count + 1)) : path
    for occ in db.symbolOccurrences(inFilePath: path) {
      let module = occ.location.moduleName
      guard let sym = id(occ.symbol, in: module) else { continue }
      let roles = occ.roles
      if roles.contains(.definition) || roles.contains(.declaration) {
        let isDefinition = roles.contains(.definition)
        if !nodes[sym].isDefinition {
          nodes[sym].file = fileId(shown)
          nodes[sym].line = occ.location.line
          nodes[sym].module = occ.location.moduleName
          nodes[sym].isDefinition = isDefinition
          nodes[sym].external = false
          nodes[sym].entry = isDefinition && Graph.isEntry(occ.symbol, line: occ.location.line, in: lines)
        }
        if isDefinition { places[Place(file: fileId(shown), line: occ.location.line, column: occ.location.utf8Column)] = sym }
        for r in occ.relations {
          guard let other = id(r.symbol, in: module) else { continue }
          if r.roles.contains(.accessorOf) { alias[sym] = other }
          if r.roles.contains(.childOf), parents[sym] == nil { parents[sym] = other }
          // The implementation of a requirement, or the override of a method: a call of the base can land here.
          if r.roles.contains(.overrideOf) { add(other, sym, "dispatch", fileId(shown), occ.location) }
        }
        continue
      }
      guard roles.contains(.reference) || roles.contains(.call) else { continue }
      let file = fileId(shown)
      for r in occ.relations {
        guard let other = id(r.symbol, in: module) else { continue }
        if r.roles.contains(.extendedBy) { alias[other] = sym }
        if r.roles.contains(.baseOf) { add(other, sym, "inherits", file, occ.location) }
      }
      let isCall = roles.contains(.call)
      let wanted: SymbolRole = isCall ? .calledBy : .containedBy
      let from: Int
      if let user = occ.relations.first(where: { $0.roles.contains(wanted) }) {
        guard let found = id(user.symbol, in: module) else { continue }
        from = found
      } else if path.hasSuffix("/main.swift") {
        // The top-level code of main.swift has no declaration, so it gets a node of its own: the entry point of the executable.
        let key = "toplevel:" + shown
        if ids[key] == nil {
          ids[key] = nodes.count
          nodes.append(Node(usr: key, name: "main.swift", kind: "function", file: file, line: 1, module: module, isDefinition: true, external: false, entry: true))
        }
        from = ids[key]!
      } else {
        continue
      }
      let kind: String
      if isCall, occ.symbol.subKind == .accessorSetter || occ.symbol.subKind == .swiftAccessorWillSet || occ.symbol.subKind == .swiftAccessorDidSet || occ.symbol.subKind == .swiftAccessorMutableAddressor {
        kind = "writes"
      } else if isCall, occ.symbol.subKind == .accessorGetter || occ.symbol.subKind == .swiftAccessorAddressor {
        kind = "reads"
      } else if isCall {
        kind = "calls"
      } else if Graph.isData(occ.symbol.kind) {
        kind = roles.contains(.write) ? "writes" : "reads"
      } else if Graph.isCallable(occ.symbol.kind) {
        kind = "refs"
      } else {
        kind = "uses"
      }
      add(from, sym, kind, file, occ.location)
    }
  }

  // --- what the reader of the bodies needs, between `read` and `finish`

  func fileIndex(_ shown: String) -> Int? { fileIds[shown] }
  func definition(at place: Place) -> Int? { places[place] }
  func topLevel(of shown: String) -> Int? { ids["toplevel:" + shown] }
  /// Each use in one file: where it is, what it uses, and the kind of the edge.
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

  /// A use of a C symbol from Swift got a key with the module of the user, as a Swift function with a C name does.
  /// When no Swift code of that module defines it, it is the C symbol itself, and it joins the node of that symbol.
  mutating func foldCNames() {
    for i in nodes.indices where nodes[i].external {
      guard nodes[i].usr.hasPrefix("c:"), let at = nodes[i].usr.lastIndex(of: "@"), ids[nodes[i].usr] == i else { continue }
      let plain = String(nodes[i].usr[..<at])
      // The key of a C symbol can hold an @ of its own. Only a key that this file made ends with the name of a module.
      guard !plain.isEmpty, cKeys.contains(nodes[i].usr) else { continue }
      if let real = ids[plain], real != i {
        alias[i] = real
      } else {
        ids[nodes[i].usr] = nil
        ids[plain] = i
        nodes[i].usr = plain
      }
    }
  }

  /// The module of each symbol of another module: from its definition in the index, or else from its mangled name.
  mutating func nameExternals(from db: IndexStoreDB) {
    // The type that holds a member comes into the list while the loop runs, and gets its module in a later turn.
    var i = -1
    while i + 1 < nodes.count {
      i += 1
      guard nodes[i].external, nodes[i].module.isEmpty else { continue }
      let usr = nodes[i].usr
      var holder: Symbol?
      var module = ""
      var system = false
      db.forEachSymbolOccurrence(byUSR: usr, roles: [.definition, .declaration]) { occ in
        module = occ.location.moduleName
        system = occ.location.isSystem
        holder = occ.relations.first { $0.roles.contains(.childOf) }?.symbol
        return false
      }
      // A member of a type of another module is named with its type, as a member of the project is.
      if let holder, parents[i] == nil, let parent = id(holder, in: module), parent != i { parents[i] = parent }
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
  private static func isEntry(_ s: Symbol, line: Int, in lines: [Substring]) -> Bool {
    // A C `main`, or the static `main()` of a type with `@main`. A free Swift function named main is not one.
    if s.name == "main", s.kind == .function, s.language != .swift { return true }
    guard isCallable(s.kind) || s.kind == .struct || s.kind == .class || s.kind == .enum else { return false }
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
  mutating func finish(keepExternal: Bool) {
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
    var used = Set<Int>()
    for key in merged.keys {
      used.insert(key.from)
      used.insert(key.to)
    }
    let aliased = Set(alias.keys)
    keep(merged) { i, node in !aliased.contains(i) && (node.external ? used.contains(i) : true) }
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
