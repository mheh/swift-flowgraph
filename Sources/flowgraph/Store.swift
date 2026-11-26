import Foundation
import IndexStore

/// A path as the index wrote it, with the slashes that the tool uses.
func indexPath(_ path: String) -> String {
  #if os(Windows)
  return path.replacingOccurrences(of: "\\", with: "/")
  #else
  return path
  #endif
}

struct Sym {
  var usr: String
  var name: String
  var kind: String
  var sub: IndexStoreSymbol.SubKind
  var local: Bool
  var swift: Bool

  init(usr: String, name: String, kind: String, sub: IndexStoreSymbol.SubKind = .none, local: Bool = false, swift: Bool = false) {
    self.usr = usr
    self.name = name
    self.kind = kind
    self.sub = sub
    self.local = local
    self.swift = swift
  }

  /// True for what is no node: a parameter, a local, a generic parameter.
  var skipped: Bool {
    kind == "parameter" || kind == "commentTag" || kind == "module" || local || sub == .swiftGenericTypeParam
  }

  var isCallable: Bool { Sym.callable.contains(kind) }
  var isData: Bool { Sym.data.contains(kind) }
  static let callable: Set<String> = ["function", "instanceMethod", "classMethod", "staticMethod", "constructor", "destructor", "conversionFunction"]
  static let data: Set<String> = ["variable", "field", "enumConstant", "instanceProperty", "classProperty", "staticProperty"]
}

struct Occ {
  var sym: Sym
  var roles: IndexStoreSymbolRoles
  var line: Int
  var column: Int
  var relations: [(roles: IndexStoreSymbolRoles, sym: Sym)]
}

/// One record of one source file, as one compilation saw the file.
/// A header has one record for each way that it was compiled, and all of them are read.
struct Reading {
  var file: String
  var record: String
  /// The module of the compilation: for a build with no modules, the binary that the object file goes into.
  var context: String
  /// The module that the symbols of the file belong to.
  var module: String
  /// True when the file is the file that was compiled, and not a file that it includes.
  var main: Bool
}

struct ReadingPlan {
  var readings: [Reading] = []
  /// For a symbol that more than one module defines under one name, the modules that define it.
  var owners: [String: Set<String>] = [:]
  /// The modules that the tool named after a binary, because the compilation named no module.
  /// Each is given with the modules whose compilations read its files.
  var binaries: [String: Set<String>] = [:]
  /// For each compilation, the modules that it reads.
  var sees: [String: Set<String>] = [:]
  /// For each file, the date of the newest compilation that read it.
  var dates: [String: Date] = [:]
}

/// The index store itself: its units and its records, with no database between.
final class RawStore {
  private let store: IndexStore
  private lazy var homes = findHomes()
  private var holders: [String: [String: Sym]] = [:]

  init(path: String, lib: String) async throws {
    store = try await IndexStoreLibrary.at(dylibPath: URL(fileURLWithPath: lib)).indexStore(at: URL(fileURLWithPath: path))
  }

  /// A compilation with no module name is named after its binary. An object file is in a directory of that binary:
  /// `<binary>.dir/` for CMake, `<target>.build/` for SwiftPM and Xcode, and for other builds the directory that holds the object file.
  static func binary(ofObject path: String) -> String {
    let parts = path.split(separator: "/")
    if let dir = parts.dropLast().last(where: { $0.hasSuffix(".dir") || $0.hasSuffix(".build") }) {
      return String(dir[..<dir.lastIndex(of: ".")!])
    }
    return parts.count >= 2 ? String(parts[parts.count - 2]) : ""
  }

  private struct Use {
    var file: String
    var record: String
    var context: String
    /// The module that the index names for the file in this compilation, or "" when it names none.
    var named: String
    var main: Bool
  }

  /// What the units say, before a module is chosen for each file.
  private struct Compilations {
    var uses: [Use] = []
    var dates: [String: Date] = [:]
    var sees: [String: Set<String>] = [:]
    /// The compilations that read each file.
    var contexts: [String: Set<String>] = [:]
    /// The files that were compiled themselves. A header is none of them.
    var mainFiles = Set<String>()
    /// The module of a file, when one compilation at least read it as a part of a module.
    var moduleOfFile: [String: String] = [:]
    /// The contexts that are named after a binary.
    var binaries = Set<String>()
  }

  /// The paths of the project files as the index can name them.
  private struct ProjectPaths {
    private var known: [String: String] = [:]

    init(_ files: Set<String>) {
      for file in files {
        known[Self.key(file)] = file
        // The index names a file by its real path, and the list of the files can name it through a link (/tmp on macOS).
        if let real = Self.real(file) { known[Self.key(real)] = file }
      }
    }

    /// Windows names one file with either slash and with letters of either case.
    private static func key(_ path: String) -> String {
      #if os(Windows)
      return indexPath(path).lowercased()
      #else
      return path
      #endif
    }

    private static func real(_ path: String) -> String? {
      #if os(Windows)
      return URL(fileURLWithPath: path).resolvingSymlinksInPath().path
      #else
      guard let real = realpath(path, nil) else { return nil }
      defer { free(real) }
      return String(cString: real)
      #endif
    }

    /// The project file that the index means by a path, or nil for a file of another project.
    mutating func file(_ named: String) -> String? {
      let path = Self.key(named)
      if let file = known[path] { return file }
      // The index also names a header as the include line reached it, with `..` in the path.
      guard path.contains("/../") || path.contains("/./") else { return nil }
      let plain = Self.key(URL(fileURLWithPath: path).standardized.path)
      known[path] = known[plain]
      return known[plain]
    }
  }

  /// Each source file that the index has a record of and that is no file of the system.
  func sourceFiles() -> [String] {
    var files = Set<String>()
    store.unitNames(sorted: true).forEach { name in
      guard let unit = try? store.unit(named: name.string) else { return .continue }
      unit.dependencies.forEach { dep in
        let url = URL(fileURLWithPath: indexPath(dep.filePath.string))
        if dep.kind == .record, !dep.isSystem, sourceExtensions.contains(url.pathExtension) { files.insert(url.standardized.path) }
        return .continue
      }
      return .continue
    }
    return files.sorted()
  }

  /// Reads the units, and says for each source file which records to read and which module its symbols belong to.
  /// `targets` are the names of the targets of the package, which a build directory can be named after.
  func plan(files: Set<String>, targets: Set<String>) -> ReadingPlan {
    var found = compilations(of: files, targets: targets)
    // The names of the units hold a hash of the build directory. The order of the files does not, so two builds of one tree give one order.
    found.uses.sort { ($0.file, $0.main ? 0 : 1, $0.context, $0.record) < ($1.file, $1.main ? 0 : 1, $1.context, $1.record) }
    // A file that was compiled into three binaries is read once for each, and so is a source file that another one includes.
    // A header is read once for each of its records.
    var once = Set<String>()
    found.uses = found.uses.filter { $0.main || found.mainFiles.contains($0.file) || once.insert($0.file + "\n" + $0.record).inserted }

    var plan = ReadingPlan()
    plan.dates = found.dates
    plan.sees = found.sees
    for use in found.uses {
      var module = use.named
      if module.isEmpty, let named = found.moduleOfFile[use.file] {
        // One compilation read the header as a part of a module, so it belongs to that module in the others too.
        module = named
      } else if module.isEmpty {
        let readers = found.contexts[use.file] ?? []
        if found.mainFiles.contains(use.file) || readers.count == 1 {
          // A source file, and a header that one binary alone reads, belong to the binary.
          module = use.context
          plan.binaries[module, default: []].insert(use.context)
        } else {
          // A header that more than one binary reads belongs to none of them: it is named after its directory.
          module = URL(fileURLWithPath: use.file).deletingLastPathComponent().lastPathComponent
          if found.binaries.contains(module) { module += " (shared)" }
          plan.binaries[module, default: []].formUnion(readers)
        }
      }
      plan.readings.append(Reading(file: use.file, record: use.record, context: use.context, module: module, main: use.main))
    }
    plan.owners = owners(of: found)
    return plan
  }

  private func compilations(of files: Set<String>, targets: Set<String>) -> Compilations {
    var names: [String] = []
    store.unitNames(sorted: true).forEach { name in
      names.append(name.string)
      return .continue
    }
    // The modules that the index names itself, and the targets of the package.
    var modules = targets
    for name in names {
      guard let unit = try? store.unit(named: name) else { continue }
      let module = unit.moduleName.string
      if !module.isEmpty { modules.insert(module) }
    }
    // A build directory can add a suffix to the name of its target (<target>-t.build). The module is then the start of the name.
    func binary(_ object: String) -> String {
      let name = RawStore.binary(ofObject: object)
      if modules.contains(name) { return name }
      if let cut = name.lastIndex(of: "-"), modules.contains(String(name[..<cut])) { return String(name[..<cut]) }
      return name
    }

    var paths = ProjectPaths(files)
    var found = Compilations()
    var seen = Set<String>()
    for name in names {
      guard let unit = try? store.unit(named: name) else { continue }
      let mainPath = unit.hasMainFile ? unit.mainFile.string : ""
      let main = paths.file(mainPath) ?? mainPath
      let unitModule = unit.moduleName.string
      let context = unitModule.isEmpty ? binary(indexPath(unit.outputFile.string)) : unitModule
      if unitModule.isEmpty { found.binaries.insert(context) }
      let date = unit.modificationDate
      unit.dependencies.forEach { dep in
        let named = dep.moduleName.string
        if !named.isEmpty { found.sees[context, default: []].insert(named) }
        guard dep.kind != .unit, let file = paths.file(dep.filePath.string) else { return .continue }
        if found.dates[file].map({ $0 < date }) ?? true { found.dates[file] = date }
        guard dep.kind == .record else { return .continue }
        let record = dep.name.string
        found.contexts[file, default: []].insert(context)
        if file == main { found.mainFiles.insert(file) }
        guard seen.insert(file + "\n" + record + "\n" + context).inserted else { return .continue }
        if !named.isEmpty, found.moduleOfFile[file] == nil { found.moduleOfFile[file] = named }
        found.uses.append(Use(file: file, record: record, context: context, named: named.isEmpty ? unitModule : named, main: file == main))
        return .continue
      }
    }
    return found
  }

  /// The C names that need their module in their key: a function or a variable that more than one compilation context defines.
  private func owners(of found: Compilations) -> [String: Set<String>] {
    var owners: [String: Set<String>] = [:]
    var always = Set<String>()
    for use in found.uses where found.mainFiles.contains(use.file) {
      guard let record = try? store.record(named: use.record) else { continue }
      record.symbols.forEach { s in
        guard s.roles.contains(.definition) else { return .continue }
        let kind = s.kind.description
        guard Sym.callable.contains(kind) || kind == "variable" else { return .continue }
        let usr = s.usr.string
        guard usr.hasPrefix("c:") else { return .continue }
        owners[usr, default: []].insert(use.context)
        // A Swift function with a C name always has its module in its key, so that the key does not change when a second module takes the name.
        if s.language == .swift { always.insert(usr) }
        return .continue
      }
    }
    return owners.filter { $0.value.count > 1 || always.contains($0.key) }
  }

  /// Where a symbol is declared: the module that the index names for the record, and the type that holds the symbol.
  struct Declaration {
    var module: String
    var system: Bool
    var holder: Sym?
  }

  private struct Home {
    var record: String
    var module: String
    var system: Bool
    /// A record with a module comes before one with none. The names decide the rest, so each build gives one answer.
    var rank: (Int, String, String) { (module.isEmpty ? 1 : 0, module, record) }
  }

  /// The record that declares each symbol of the store. A symbol of another module is in no file of the project,
  /// and the records of that module say where it belongs.
  private func findHomes() -> [String: Home] {
    var names: [String] = []
    store.unitNames(sorted: true).forEach { name in
      names.append(name.string)
      return .continue
    }
    var homes: [String: Home] = [:]
    var seen = Set<String>()
    for name in names {
      guard let unit = try? store.unit(named: name) else { continue }
      let unitModule = unit.moduleName.string
      unit.dependencies.forEach { dep in
        guard dep.kind == .record else { return .continue }
        let named = dep.moduleName.string
        let home = Home(record: dep.name.string, module: named.isEmpty ? unitModule : named, system: dep.isSystem)
        guard seen.insert(home.record + "\n" + home.module).inserted, let record = try? store.record(named: home.record) else { return .continue }
        record.symbols.forEach { s in
          guard !s.roles.isDisjoint(with: [.definition, .declaration]) else { return .continue }
          let usr = s.usr.string
          if let old = homes[usr], old.rank <= home.rank { return .continue }
          homes[usr] = home
          return .continue
        }
        return .continue
      }
    }
    return homes
  }

  func declaration(of usr: String) -> Declaration? {
    guard let home = homes[usr] else { return nil }
    if holders[home.record] == nil {
      var found: [String: Sym] = [:]
      forEachOccurrence(of: home.record) { occ in
        guard !occ.roles.isDisjoint(with: [.definition, .declaration]), found[occ.sym.usr] == nil,
          let holder = occ.relations.first(where: { $0.roles.contains(.childOf) })?.sym
        else { return }
        found[occ.sym.usr] = holder
      }
      holders[home.record] = found
    }
    return Declaration(module: home.module, system: home.system, holder: holders[home.record]?[usr])
  }

  func forEachOccurrence(of record: String, _ body: (Occ) -> Void) {
    guard let record = try? store.record(named: record) else { return }
    func copy(_ s: borrowing IndexStoreSymbol) -> Sym {
      let usr = s.usr.string
      var name = s.name.string
      // A C struct, union or enum that has only the name of its typedef has no name of its own. Its USR ends in that name.
      if name.isEmpty, usr.hasPrefix("c:"), let at = usr.lastIndex(of: "@") {
        let before = usr[..<at]
        if before.hasSuffix("@SA") || before.hasSuffix("@UA") || before.hasSuffix("@EA") { name = String(usr[usr.index(after: at)...]) }
      }
      return Sym(usr: usr, name: name, kind: s.kind.description, sub: s.subKind, local: s.properties.contains(.local), swift: s.language == .swift)
    }
    record.occurrences.forEach { o in
      var relations: [(roles: IndexStoreSymbolRoles, sym: Sym)] = []
      o.relations.forEach { r in
        relations.append((r.roles, copy(r.symbol)))
        return .continue
      }
      let position = o.position
      body(Occ(sym: copy(o.symbol), roles: o.roles, line: position.line, column: position.column, relations: relations))
      return .continue
    }
  }
}
