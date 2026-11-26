import Foundation

func log(_ text: String) {
  FileHandle.standardError.write(Data((text + "\n").utf8))
}

/// The index reader of the toolchain of the swift in use. Windows keeps it beside the tools.
func findLibIndexStore() -> String? {
  guard let swift = run("/usr/bin/xcrun", ["--find", "swift"]) ?? find(tool: "swift") else { return nil }
  let usr = URL(fileURLWithPath: swift).resolvingSymlinksInPath().deletingLastPathComponent().deletingLastPathComponent()
  for name in ["lib/libIndexStore.dylib", "lib/libIndexStore.so", "bin/libIndexStore.dll"] {
    let path = usr.appendingPathComponent(name).path
    if FileManager.default.fileExists(atPath: path) { return path }
  }
  return nil
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

/// The same text gives the same number in each run, so a cache directory keeps its name.
func stableHash(_ text: String) -> UInt64 {
  text.utf8.reduce(UInt64(14_695_981_039_346_656_037)) { ($0 ^ UInt64($1)) &* 1_099_511_628_211 }
}
