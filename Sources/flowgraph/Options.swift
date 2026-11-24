import Foundation

/// What the command line asked for.
struct Options {
  enum Command { case snapshot, page, site, listEntries, listProducts }
  var command = Command.snapshot
  var project = FileManager.default.currentDirectoryPath
  var roots: [String] = []
  var entries: [String] = []
  var product: String?
  var checkouts = false
  var indexStore: String?
  var libIndexStore: String?
  var symbolGraphs: String?
  var sources: [String] = []
  var external = true
  var bodies = true
  var cone = false
  var up: String?
  var down: String?
  var out: String?
  var html: String?
  var snapshot: String?
  var title: String?
  var ref: String?
  var build = "swift build"

  static let usage = """
    usage:
      flowgraph snapshot [project-dir] [options]   Write the snapshot of a project: its symbols and edges, as JSON.
      flowgraph page [--snapshot <file>]           Write the viewer as one HTML file, empty or with a snapshot inside.
      flowgraph site                               Write the viewer as a folder of static files, for a web host.
      flowgraph list entries [project-dir]         Print the entry points that the sources mark.
      flowgraph list products [project-dir]        Print the products of the package and of its checkouts.

      --out <path>           snapshot: the JSON file. page: the HTML file (default flowgraph.html). site: the folder (default flowgraph-site).

    snapshot:
      --html <file.html>     Also write the viewer with this snapshot inside it, as one file.
      --root <name>          Symbol that the page starts from: a name, Type.member, Module.name, or a USR. Repeatable.
      --entry <name>         An entry point that the page starts from: all that it reaches, grouped by its branches. Repeatable.
      --product <name>       A product of the package: the page starts from its entry points, with only its targets.
      --up <n|max>           Depth of callers and users in the first view. Default 1, or 0 with --entry.
      --down <n|max>         Depth of callees and uses in the first view. Default 2, or max with --entry.
      --cone                 Keep only what the roots reach, up and down. Default: the whole project.
      --symbol-graphs <dir>  Directory of *.symbols.json, for declarations and doc comments.
      --title <text>         Name of the project in the page. Default: the name of the project directory.
      --ref <branch|commit>  Take the snapshot of another commit: it is checked out in a worktree outside the project, and built there.
      --build <command>      The build command for --ref. Default: swift build

    snapshot and list:
      --sources <dir>        Directory to scan, relative to the project. Repeatable. Default: the project.
      --checkouts            Also read the sources of the dependencies in .build/checkouts.
      --no-external          Drop the symbols of other modules (the SDK, dependencies). Default: they are leaf nodes.
      --no-bodies            Do not read the bodies of the functions. The page then has no trace.
      --index-store <path>   Index store. Default: found under .build or Xcode DerivedData.
      --libindexstore <path> libIndexStore.dylib. Default: from the toolchain of `xcrun --find swift`.
    """

  init(_ arguments: [String]) throws {
    var rest = arguments[...]
    var sawProject = false
    func value(_ flag: String) throws -> String {
      guard let v = rest.popFirst() else { throw Failure("\(flag) needs a value") }
      return v
    }
    switch rest.popFirst() {
    case "snapshot": command = .snapshot
    case "page": command = .page
    case "site": command = .site
    case "list":
      switch rest.popFirst() {
      case "entries": command = .listEntries
      case "products": command = .listProducts
      default: throw Failure("list needs entries or products\n\n\(Options.usage)")
      }
    case "-h", "--help", nil: throw Failure(Options.usage)
    case let other?: throw Failure("unknown command \(other)\n\n\(Options.usage)")
    }
    while let a = rest.popFirst() {
      switch a {
      case "--root": roots.append(try value(a))
      case "--entry": entries.append(try value(a))
      case "--product": product = try value(a)
      case "--checkouts": checkouts = true
      case "--up": up = try value(a)
      case "--down": down = try value(a)
      case "--out": out = try value(a)
      case "--html": html = try value(a)
      case "--snapshot": snapshot = try value(a)
      case "--cone": cone = true
      case "--no-external": external = false
      case "--no-bodies": bodies = false
      case "--sources": sources.append(try value(a))
      case "--index-store": indexStore = try value(a)
      case "--symbol-graphs": symbolGraphs = try value(a)
      case "--libindexstore": libIndexStore = try value(a)
      case "--title": title = try value(a)
      case "--ref": ref = try value(a)
      case "--build": build = try value(a)
      case "-h", "--help": throw Failure(Options.usage)
      default:
        guard !a.hasPrefix("-"), !sawProject else { throw Failure("unknown argument \(a)\n\n\(Options.usage)") }
        project = a
        sawProject = true
      }
    }
    if command == .snapshot, out == nil, html == nil { out = "snapshot.json" }
    project = URL(fileURLWithPath: project).standardizedFileURL.resolvingSymlinksInPath().path
  }
}

struct Failure: Error, CustomStringConvertible {
  var description: String
  init(_ description: String) { self.description = description }
}

func log(_ text: String) {
  FileHandle.standardError.write(Data((text + "\n").utf8))
}

/// The output of one command, or nil when it fails.
func run(_ tool: String, _ arguments: [String]) -> String? {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: tool)
  p.arguments = arguments
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = FileHandle.nullDevice
  guard (try? p.run()) != nil else { return nil }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  guard p.terminationStatus == 0 else { return nil }
  return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

/// The index store of a project: SwiftPM writes it under .build, Xcode under DerivedData.
/// Each store that can be the one of the project, the newest first.
func findIndexStores(project: String) -> [String] {
  let fm = FileManager.default
  func isStore(_ path: String) -> Bool { fm.fileExists(atPath: path + "/v5/units") }
  var candidates: [String] = []
  let build = project + "/.build"
  for sub in ["index-build", ""] {
    let base = sub.isEmpty ? build : build + "/" + sub
    candidates.append(base + "/debug/index/store")
    // The Swift Build backend of SwiftPM writes the store here.
    candidates.append(base + "/out")
    for triple in (try? fm.contentsOfDirectory(atPath: base)) ?? [] {
      candidates.append(base + "/\(triple)/debug/index/store")
    }
  }
  let derived = NSHomeDirectory() + "/Library/Developer/Xcode/DerivedData"
  let name = URL(fileURLWithPath: project).lastPathComponent
  for dir in (try? fm.contentsOfDirectory(atPath: derived)) ?? [] where dir.hasPrefix(name + "-") && !dir.dropFirst(name.count + 1).contains("-") {
    candidates.append(derived + "/\(dir)/Index.noindex/DataStore")
  }
  // The newest store comes first, so a stale build does not shadow the editor's index.
  func date(_ path: String) -> Date {
    ((try? fm.attributesOfItem(atPath: path + "/v5/units"))?[.modificationDate] as? Date) ?? .distantPast
  }
  return candidates.filter(isStore).sorted { date($0) > date($1) }
}

func findLibIndexStore() -> String? {
  guard let swift = run("/usr/bin/xcrun", ["--find", "swift"]) ?? run("/usr/bin/which", ["swift"]) else { return nil }
  let lib = URL(fileURLWithPath: swift).resolvingSymlinksInPath().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("lib")
  for name in ["libIndexStore.dylib", "libIndexStore.so"] {
    let path = lib.appendingPathComponent(name).path
    if FileManager.default.fileExists(atPath: path) { return path }
  }
  return nil
}
