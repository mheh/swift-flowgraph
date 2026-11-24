import Foundation
import IndexStoreDB

let sourceExtensions: Set<String> = ["swift", "c", "h", "m", "mm", "cc", "cpp", "cxx", "hpp", "hh"]
let skippedDirectories: Set<String> = ["node_modules", "DerivedData", "Pods", "Carthage", "build"]

func sourceFiles(under roots: [String]) -> [String] {
  var found: [String] = []
  for root in roots {
    let url = URL(fileURLWithPath: root)
    guard let walk = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])
    else { continue }
    for case let item as URL in walk {
      if (try? item.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
        if skippedDirectories.contains(item.lastPathComponent) { walk.skipDescendants() }
      } else if sourceExtensions.contains(item.pathExtension) {
        found.append(item.resolvingSymlinksInPath().path)
      }
    }
  }
  return found.sorted()
}

/// The declaration and the first line of the doc comment of each symbol, from `*.symbols.json` files.
func readSymbolGraphs(in directory: String, into graph: Graph) -> (decl: [Int: String], doc: [Int: String]) {
  var decl: [Int: String] = [:]
  var doc: [Int: String] = [:]
  let names = ((try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? []).filter { $0.hasSuffix(".symbols.json") }
  for name in names {
    guard let data = FileManager.default.contents(atPath: directory + "/" + name),
      let top = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let symbols = top["symbols"] as? [[String: Any]]
    else { continue }
    for s in symbols {
      guard let usr = (s["identifier"] as? [String: Any])?["precise"] as? String, let i = graph.index(ofUSR: usr) else { continue }
      if let fragments = s["declarationFragments"] as? [[String: Any]] {
        decl[i] = fragments.compactMap { $0["spelling"] as? String }.joined()
      }
      if let lines = (s["docComment"] as? [String: Any])?["lines"] as? [[String: Any]],
        let first = lines.compactMap({ $0["text"] as? String }).first(where: { !$0.isEmpty && !$0.hasPrefix("```") })
      {
        doc[i] = first
      }
    }
  }
  return (decl, doc)
}

func depth(_ text: String) throws -> Int {
  if text == "max" { return -1 }
  guard let n = Int(text), n >= 0 else { throw Failure("a depth is a number or max, not \(text)") }
  return n
}

/// Opens one index store. The database is a cache of the store, so it lives outside the project.
func openIndex(store: String, lib: String) throws -> IndexStoreDB {
  let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("flowgraph/\(store.utf8.reduce(UInt64(14_695_981_039_346_656_037)) { ($0 ^ UInt64($1)) &* 1_099_511_628_211 })")
  try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
  let db = try IndexStoreDB(
    storePath: store, databasePath: cache.path, library: IndexStoreLibrary(dylibPath: lib),
    waitUntilDoneInitializing: true, listenToUnitEvents: false)
  db.pollForUnitChangesAndWait()
  return db
}

/// The graph of one project from its index store.
func readGraph(_ options: Options, checkoutDirectories: [String]) throws -> (graph: Graph, outlines: [Int: Outline], fileCount: Int, indexed: Date?, stale: Int) {
  let stores = options.indexStore.map { [$0] } ?? findIndexStores(project: options.project)
  guard !stores.isEmpty else {
    throw Failure("no index store under \(options.project). Build the project first (swift build), or give --index-store.")
  }
  guard let lib = options.libIndexStore ?? findLibIndexStore() else {
    throw Failure("libIndexStore was not found. Give --libindexstore.")
  }
  let scanned = options.sources.isEmpty ? [options.project] : options.sources.map { $0.hasPrefix("/") ? $0 : options.project + "/" + $0 }
  let files = sourceFiles(under: scanned + checkoutDirectories)
  // A store of a build of another copy of the project has no symbol for these files: the next store is tried then.
  var opened: (store: String, db: IndexStoreDB)?
  for store in stores {
    let db = try openIndex(store: store, lib: lib)
    if files.contains(where: { path in !db.symbolOccurrences(inFilePath: path).isEmpty }) {
      opened = (store, db)
      break
    }
    log("index store with no symbol of these sources: \(store)")
  }
  guard let (store, db) = opened else {
    throw Failure("no index has a symbol for the \(files.count) source files under \(scanned.joined(separator: ", ")). Build the project first (swift build), or give --index-store.")
  }
  log("index store: \(store)")

  var graph = Graph()
  for file in files { graph.read(file: file, relativeTo: options.project, from: db) }
  graph.foldCNames()
  graph.nameExternals(from: db)
  // The bodies are read before the graph is folded, because a closure that goes to another module becomes a node.
  var early: [Int: Outline] = [:]
  if options.bodies {
    let rules = EntryRules(project: options.project)
    for path in files where path.hasSuffix(".swift") {
      let shown = path.hasPrefix(options.project + "/") ? String(path.dropFirst(options.project.count + 1)) : path
      guard let file = graph.fileIndex(shown) else { continue }
      early.merge(BodyReader.read(path: path, file: file, shown: shown, rules: rules, into: &graph)) { old, _ in old }
    }
  }
  graph.finish(keepExternal: options.external)
  guard !graph.nodes.isEmpty else {
    throw Failure("the index has no symbol for the \(files.count) source files under \(scanned.joined(separator: ", ")). Is the index of this project?")
  }
  // The snapshot is as fresh as the index: a source file that changed after the last build is not in it.
  func changed(_ path: String) -> Date? { (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date }
  let indexed = changed(store + "/v5/units")
  // Each file has its own date in the index, because a build that fails writes the units of some files only.
  let stale = files.filter { path in
    guard let unit = db.dateOfLatestUnitFor(filePath: path) else { return path.hasSuffix(".swift") }
    return (changed(path) ?? .distantPast) > unit
  }.count
  if stale > 0 { log("warning: \(stale) source files changed after the index was written. Build the project again for a snapshot of the current code.") }
  return (graph, early, files.count, indexed, stale)
}

/// Checks another commit of the project out and builds it, and points the options at that copy.
/// The worktree is in the cache directory and stays there, so the next build of the same ref is short.
func checkOut(_ ref: String, for options: inout Options) throws {
  func sh(_ command: String, in directory: String) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", command]
    p.currentDirectoryURL = URL(fileURLWithPath: directory)
    p.standardOutput = FileHandle.standardError
    guard (try? p.run()) != nil else { return -1 }
    p.waitUntilExit()
    return p.terminationStatus
  }
  func quoted(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
  guard let top = run("/usr/bin/env", ["git"] + ["-C", options.project, "rev-parse", "--show-toplevel"])?.trimmingCharacters(in: .whitespacesAndNewlines), !top.isEmpty else {
    throw Failure("--ref needs a git repository, and \(options.project) is not in one")
  }
  let top2 = URL(fileURLWithPath: top).resolvingSymlinksInPath().path
  let inside = options.project.hasPrefix(top2) ? String(options.project.dropFirst(top2.count)) : ""
  let name = URL(fileURLWithPath: options.project).lastPathComponent
  let safe = String(ref.map { $0.isLetter || $0.isNumber || "-_.".contains($0) ? $0 : "-" })
  let hash = top2.utf8.reduce(UInt64(14_695_981_039_346_656_037)) { ($0 ^ UInt64($1)) &* 1_099_511_628_211 }
  let tree = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("flowgraph/worktrees/\(name)-\(hash)/\(safe)").path
  if FileManager.default.fileExists(atPath: tree + "/.git") {
    guard sh("git checkout --quiet --detach \(quoted(ref))", in: tree) == 0 else { throw Failure("git could not check out \(ref) in \(tree)") }
  } else {
    try FileManager.default.createDirectory(atPath: (tree as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    guard sh("git worktree prune && git worktree add --quiet --detach \(quoted(tree)) \(quoted(ref))", in: top2) == 0 else { throw Failure("git could not make a worktree of \(ref)") }
  }
  log("building \(ref) in \(tree + inside): \(options.build)")
  guard sh(options.build, in: tree + inside) == 0 else { throw Failure("the build of \(ref) failed: \(options.build)") }
  options.title = options.title ?? name
  options.project = URL(fileURLWithPath: tree + inside).resolvingSymlinksInPath().path
}

/// Where the snapshot came from: the name of the project, and the commit when the project is a git repository.
func projectInfo(_ options: Options, indexed: Date?, stale: Int) -> [String: Any] {
  func git(_ arguments: String...) -> String? { run("/usr/bin/env", ["git"] + ["-C", options.project] + arguments) }
  var info: [String: Any] = [
    "name": options.title ?? URL(fileURLWithPath: options.project).lastPathComponent,
    "created": ISO8601DateFormatter().string(from: Date()),
  ]
  if let indexed { info["indexed"] = ISO8601DateFormatter().string(from: indexed) }
  info["staleFiles"] = stale
  if let commit = git("rev-parse", "--short", "HEAD") {
    info["commit"] = commit
    info["branch"] = options.ref ?? git("rev-parse", "--abbrev-ref", "HEAD") ?? ""
    info["dirty"] = !(git("status", "--porcelain", "--untracked-files=no") ?? "").isEmpty
  }
  return info
}

/// The snapshot of one project, in the format that web/core.js documents.
func makeSnapshot(_ options: Options) throws -> Data {
  let byEntry = !options.entries.isEmpty || options.product != nil
  let up = try depth(options.up ?? (byEntry ? "0" : "1"))
  let down = try depth(options.down ?? (byEntry ? "max" : "2"))
  let (packages, checkoutDirectories) = readPackages(project: options.project, withCheckouts: options.checkouts || options.product != nil)
  if let wanted = options.product, !packages.contains(where: { $0.products.contains { $0.name == wanted } }) {
    throw Failure("no product is named \(wanted). `flowgraph list products` prints them.")
  }
  var (graph, early, fileCount, indexed, stale) = try readGraph(options, checkoutDirectories: options.checkouts ? checkoutDirectories : [])

  let moduleProducts = memberships(of: packages)
  var roots: [Int] = []
  for root in options.roots + options.entries {
    let found = graph.find(root)
    guard !found.isEmpty else { throw Failure("no symbol is named \(root)") }
    if found.count > 1 { log("\(root) names \(found.count) symbols: \(found.prefix(8).map { graph.nodes[$0].name }.joined(separator: ", "))") }
    roots += found
  }
  if options.cone {
    guard !roots.isEmpty else { throw Failure("--cone needs a --root") }
    let usrs = roots.map { graph.nodes[$0].usr }
    graph.cone(of: roots)
    roots = usrs.compactMap(graph.index(ofUSR:))
  }

  // The outlines were made with the nodes of the reader. They now name the nodes that are left.
  let final = graph.finalId
  func row(_ step: Step) -> [Any] {
    var refs: [Int] = []
    // An accessor and its property are one node now, so one step can name the same use twice.
    var seen = Set<EdgeKey>()
    for ref in step.refs where final[ref.to] >= 0 && seen.insert(EdgeKey(from: 0, to: final[ref.to], kind: ref.kind)).inserted { refs += [final[ref.to], ref.kind] }
    var row: [Any] = [step.kind, step.line, step.hash != 0 ? [step.text, step.hash] as Any : step.text as Any, refs, step.flags, step.children.map(row)]
    // The end of a row is left out when it is empty.
    if step.children.isEmpty {
      row.removeLast()
      if step.flags == 0 {
        row.removeLast()
        if refs.isEmpty { row.removeLast() }
      }
    }
    return row
  }
  var bodies: [String: Any] = [:]
  for (early, outline) in early where final[early] >= 0 { bodies["\(final[early])"] = [outline.flags, outline.endLine, outline.steps.map(row)] as [Any] }
  var labels: [String: String] = [:]
  for (i, n) in graph.nodes.enumerated() where !n.label.isEmpty { labels["\(i)"] = n.label }

  let extra = options.symbolGraphs.map { readSymbolGraphs(in: $0, into: graph) }
  var kinds: [String] = []
  var modules: [String] = []
  var packageNames: [String] = []
  func intern(_ value: String, _ list: inout [String]) -> Int {
    if let i = list.firstIndex(of: value) { return i }
    list.append(value)
    return list.count - 1
  }
  func packageName(_ n: Node) -> String {
    guard n.file >= 0 else { return "" }
    let path = graph.files[n.file]
    return packages.first { !$0.prefix.isEmpty && path.hasPrefix($0.prefix) }?.name ?? packages.first { $0.prefix.isEmpty }?.name ?? ""
  }
  let symbolRows: [[Any]] = graph.nodes.map { n in
    [n.name, intern(n.kind, &kinds), n.file, n.line, n.parent, intern(n.module, &modules), n.external ? (n.system ? 2 : 1) : 0, n.entry ? 1 : 0, intern(packageName(n), &packageNames)]
  }
  let edgeRows: [[Int]] = graph.edges.map { [$0.key.from, $0.key.to, $0.key.kind, $0.value.count, $0.value.line] }
    .sorted { ($0[0], $0[1], $0[2]) < ($1[0], $1[1], $1[2]) }
  let snapshot: [String: Any] = [
    "format": "flowgraph", "version": 1, "project": projectInfo(options, indexed: indexed, stale: stale),
    "files": graph.files, "kinds": kinds, "modules": modules, "packages": packageNames, "edgeKinds": edgeKinds,
    "symbols": symbolRows, "usrs": graph.nodes.map(\.usr), "edges": edgeRows,
    "products": packages.flatMap { p in p.products.map { ["name": $0.name, "type": $0.type, "package": p.name] } },
    "moduleProducts": moduleProducts,
    "stepKinds": stepKinds, "bodies": bodies, "labels": labels, "replace": EntryRules(project: options.project).replace,
    "decl": Dictionary(uniqueKeysWithValues: (extra?.decl ?? [:]).map { ("\($0)", $1) }),
    "doc": Dictionary(uniqueKeysWithValues: (extra?.doc ?? [:]).map { ("\($0)", $1) }),
    "view": [
      "roots": roots, "up": up, "down": down, "group": options.product != nil ? "module" : byEntry ? "branch" : "file", "fnOnly": byEntry,
      "product": options.product ?? "",
    ] as [String: Any],
  ]
  log("\(fileCount) files, \(graph.nodes.count) symbols, \(graph.edges.count) edges, \(bodies.count) bodies")
  return try JSONSerialization.data(withJSONObject: snapshot, options: [.withoutEscapingSlashes, .sortedKeys])
}
