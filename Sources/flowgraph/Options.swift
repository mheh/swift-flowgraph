import Foundation

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
  var fromIndex = false
  var cone = false
  var up: String?
  var down: String?
  var out: String?
  var html: String?
  var snapshot: String?
  var exporter: String?
  var title: String?
  var ref: String?
  var build = "swift build"

  static let usage = """
    usage:
      flowgraph snapshot [project-dir] [options]   Write the snapshot of a project: its symbols and edges, as JSON.
      flowgraph page [--snapshot <file>]           Write the viewer as one HTML file, empty or with a snapshot inside.
      flowgraph site [--exporter <file.wasm>]      Write the viewer as a folder of static files, for a web host.
                                                   With the exporter of Wasm/build.sh, the page reads an index store itself.
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
      --from-index           Take the source files from the index and not from the disk, for an index that another computer built.
                             The project directory gives the text of the lines, when it holds the sources.
      --index-store <path>   Index store. Default: found under .build or Xcode DerivedData.
      --libindexstore <path> libIndexStore.dylib or .so. Default: from the toolchain of the swift in use.
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
      case "--exporter": exporter = try value(a)
      case "--cone": cone = true
      case "--no-external": external = false
      case "--no-bodies": bodies = false
      case "--from-index": fromIndex = true
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
