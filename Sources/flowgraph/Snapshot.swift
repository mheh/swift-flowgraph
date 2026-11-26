import Foundation

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

/// Where the snapshot came from: the name of the project, and the commit when the project is a git repository.
func projectInfo(_ options: Options, root: String, indexed: Date?, stale: Int, unindexed: Int) -> [String: Any] {
  func git(_ arguments: String...) -> String? { run("git", ["-C", options.project] + arguments) }
  var info: [String: Any] = [
    "name": options.title ?? URL(fileURLWithPath: root).lastPathComponent,
    "created": ISO8601DateFormatter().string(from: Date()),
  ]
  if let indexed { info["indexed"] = ISO8601DateFormatter().string(from: indexed) }
  info["staleFiles"] = stale
  if unindexed > 0 { info["unindexedFiles"] = unindexed }
  if let commit = git("rev-parse", "--short", "HEAD") {
    info["commit"] = commit
    info["branch"] = options.ref ?? git("rev-parse", "--abbrev-ref", "HEAD") ?? ""
    info["dirty"] = !(git("status", "--porcelain", "--untracked-files=no") ?? "").isEmpty
  }
  return info
}

/// The snapshot of one project, in the format that web/model.js documents.
func makeSnapshot(_ options: Options) async throws -> Data {
  let byEntry = !options.entries.isEmpty || options.product != nil
  let up = try depth(options.up ?? (byEntry ? "0" : "1"))
  let down = try depth(options.down ?? (byEntry ? "max" : "2"))
  let (packages, checkoutDirectories) = readPackages(project: options.project, withCheckouts: options.checkouts || options.product != nil)
  if let wanted = options.product, !packages.contains(where: { $0.products.contains { $0.name == wanted } }) {
    throw Failure("no product is named \(wanted). `flowgraph list products` prints them.")
  }
  let targets = targetNames(of: packages)
  let read = try await readGraph(options, checkoutDirectories: options.checkouts ? checkoutDirectories : [], targets: targets)
  var graph = read.graph
  let (early, fileCount, indexed, stale, unindexed) = (read.outlines, read.fileCount, read.indexed, read.stale, read.unindexed)

  var moduleProducts = memberships(of: packages)
  let binaryNames = addBinaries(read.binaries, to: &moduleProducts, targets: targets)
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
    "format": "flowgraph", "version": 1, "project": projectInfo(options, root: read.root, indexed: indexed, stale: stale, unindexed: unindexed),
    "files": graph.files, "kinds": kinds, "modules": modules, "packages": packageNames, "edgeKinds": edgeKinds,
    "symbols": symbolRows, "usrs": graph.nodes.map(\.usr), "edges": edgeRows,
    "products": packages.flatMap { p in p.products.map { ["name": $0.name, "type": $0.type, "package": p.name] } }
      + binaryNames.map { ["name": $0, "type": "binary", "package": ""] },
    "moduleProducts": moduleProducts,
    "stepKinds": stepKinds, "bodies": bodies, "labels": labels, "replace": try EntryRules(project: options.project).replace,
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
