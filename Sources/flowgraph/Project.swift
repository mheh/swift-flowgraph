import Foundation

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

/// The source files of an index that another computer built: the directory of the project there, and the same directory here.
struct Relocation {
  var root: String
  var local: String

  /// The root is the deepest directory that holds nine of ten files, and it is above each directory of `sources`.
  /// The few files outside it are what the build system compiled for itself.
  /// When the files are here below `local` with more of their path, the root is that much higher.
  init(files: [String], sources: [String], local: String) {
    let stops = Set(sources.compactMap { $0.split(separator: "/").first })
    var root = ""
    var inside = files
    while true {
      var children: [Substring: Int] = [:]
      for file in inside {
        let rest = file.dropFirst(root.count + 1)
        if let cut = rest.firstIndex(of: "/") { children[rest[..<cut], default: 0] += 1 }
      }
      guard let most = children.max(by: { ($0.value, $1.key) < ($1.value, $0.key) }),
        most.value * 10 >= files.count * 9, !stops.contains(most.key) else { break }
      root += "/" + most.key
      inside = inside.filter { $0.hasPrefix(root + "/") }
    }
    if let file = inside.first {
      var higher = root
      while !higher.isEmpty, !FileManager.default.fileExists(atPath: local + file.dropFirst(higher.count)) {
        higher = String(higher[..<(higher.lastIndex(of: "/") ?? higher.startIndex)])
      }
      if !higher.isEmpty { root = higher }
    }
    self.root = root
    self.local = local
  }

  func here(_ path: String) -> String { path.hasPrefix(root + "/") ? local + path.dropFirst(root.count) : path }
}

/// What `readGraph` gives: the graph of a project, and what the index says about the build that made it.
struct ProjectGraph {
  var graph: Graph
  /// The outline of the body of each function, by the number that the node had before the graph was folded (`Graph.finalId`).
  var outlines: [Int: Outline]
  var fileCount: Int
  /// The date of the index, and the counts of the source files that are newer than it or not in it.
  var indexed: Date?
  var stale: Int
  var unindexed: Int
  /// The modules that are named after a binary, each with the binaries that read its files (`ReadingPlan.binaries`).
  var binaries: [String: Set<String>]
  /// The directory that the paths of the files are relative to.
  var root: String
}

/// The graph of one project from its index store. `targets` are the names of the targets of its packages.
func readGraph(_ options: Options, checkoutDirectories: [String], targets: Set<String>) async throws -> ProjectGraph {
  let stores = options.indexStore.map { [$0] } ?? findIndexStores(project: options.project)
  guard !stores.isEmpty else {
    throw Failure("no index store under \(options.project). Build the project first (swift build), or give --index-store.")
  }
  guard let lib = options.libIndexStore ?? findLibIndexStore() else {
    throw Failure("libIndexStore was not found. Give --libindexstore.")
  }
  let scanned = options.sources.isEmpty ? [options.project] : options.sources.map { $0.hasPrefix("/") ? $0 : options.project + "/" + $0 }
  var files = options.fromIndex ? [] : sourceFiles(under: scanned + checkoutDirectories)
  var moved: Relocation?
  // A store of a build of another copy of the project has no symbol for these files: the next store is tried then.
  var opened: (store: String, raw: RawStore, plan: ReadingPlan)?
  for store in stores {
    let raw = try await RawStore(path: store, lib: lib)
    if options.fromIndex {
      let all = raw.sourceFiles()
      let found = Relocation(files: all, sources: options.sources, local: options.project)
      moved = found
      let kept = options.sources.isEmpty ? [found.root] : options.sources.map { found.root + "/" + $0 }
      files = all.filter { file in kept.contains { file.hasPrefix($0 + "/") } }
    }
    let plan = raw.plan(files: Set(files), targets: targets)
    if !plan.readings.isEmpty {
      opened = (store, raw, plan)
      break
    }
    log("index store with no symbol of these sources: \(store)")
  }
  guard let (store, raw, plan) = opened else {
    throw Failure("no index has a symbol for the \(files.count) source files under \(scanned.joined(separator: ", ")). Build the project first (swift build), or give --index-store.")
  }
  log("index store: \(store)")

  let root = moved?.root ?? options.project
  func here(_ path: String) -> String { moved?.here(path) ?? path }

  var graph = Graph()
  graph.owners = plan.owners
  graph.sees = plan.sees
  for reading in plan.readings { graph.read(reading, relativeTo: root, textAt: here(reading.file), from: raw) }
  graph.nameExternals(from: raw)
  // The bodies are read before the graph is folded, because a closure that goes to another module becomes a node.
  let rules = try EntryRules(project: options.project)
  var early: [Int: Outline] = [:]
  #if canImport(SwiftParser)
  if options.bodies {
    for path in files where path.hasSuffix(".swift") {
      let shown = path.hasPrefix(root + "/") ? String(path.dropFirst(root.count + 1)) : path
      guard let file = graph.fileIndex(shown) else { continue }
      early.merge(BodyReader.read(path: here(path), file: file, shown: shown, rules: rules, into: &graph)) { old, _ in old }
    }
  }
  #endif
  graph.finish(keepExternal: options.external) { rules.allows(module: $0.module, name: $0.name) }
  guard !graph.nodes.isEmpty else {
    throw Failure("the index has no symbol for the \(files.count) source files under \(scanned.joined(separator: ", ")). Is the index of this project?")
  }
  // The snapshot is as fresh as the index: a source file that changed after the last build is not in it.
  func changed(_ path: String) -> Date? { (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date }
  let indexed = changed(store + "/v5/units")
  // Each file has its own date in the index, because a build that fails writes the units of some files only.
  // A file with no unit was not compiled: the build made another product, or the file belongs to another platform.
  // It is stale only when it is newer than the index, because then the build has not seen it yet.
  // With the files of the index itself, the dates of the sources here say nothing: they are a copy, or they are not here.
  var stale = 0, unindexed = 0
  for path in files where !options.fromIndex {
    let date = changed(path) ?? .distantPast
    if let unit = plan.dates[path] {
      if date > unit { stale += 1 }
    } else if path.hasSuffix(".swift") {
      if let indexed, date > indexed { stale += 1 } else { unindexed += 1 }
    }
  }
  if stale > 0 { log("warning: \(stale) source files changed after the index was written. Build the project again for a snapshot of the current code.") }
  if unindexed > 0 { log("note: \(unindexed) Swift files are not in the index, because the build did not compile them. The snapshot has no symbol of them.") }
  return ProjectGraph(graph: graph, outlines: early, fileCount: files.count, indexed: indexed, stale: stale, unindexed: unindexed, binaries: plan.binaries, root: root)
}
