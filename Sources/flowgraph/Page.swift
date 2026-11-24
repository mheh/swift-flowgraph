import Foundation

/// The viewer: index.html, core.js, and one view-*.js for each view, as the resources of the tool.
struct Page {
  let web: URL

  init() throws {
    guard let web = Bundle.module.url(forResource: "web", withExtension: nil) else { throw Failure("the web resources are missing from the build") }
    self.web = web
  }

  /// The page as one file with no network access: each script that index.html names is put inside it.
  /// With a snapshot, the page opens with that data. With none, it asks for a snapshot file.
  func singleFile(snapshot: Data?) throws -> String {
    var page = try String(contentsOf: web.appendingPathComponent("index.html"), encoding: .utf8)
    let tag = #/<script src="([^"]+)"></script>/#
    while let match = page.firstMatch(of: tag) {
      let script = try String(contentsOf: web.appendingPathComponent(String(match.1)), encoding: .utf8)
      page.replaceSubrange(match.range, with: "<script>\(script)\n</script>")
    }
    if let snapshot {
      let mark = "/*__SNAPSHOT__*/null"
      guard let range = page.range(of: mark, options: .backwards) else { throw Failure("index.html has no \(mark)") }
      // A "</" in the data would end the script element.
      page.replaceSubrange(range, with: String(decoding: snapshot, as: UTF8.self).replacingOccurrences(of: "</", with: "<\\/"))
    }
    return page
  }

  /// The page as a folder of static files, for a web host. It opens a snapshot that the user chooses, or the one that `?snapshot=<url>` names.
  func site(at directory: String) throws {
    let fm = FileManager.default
    try fm.createDirectory(atPath: directory, withIntermediateDirectories: true)
    for name in try fm.contentsOfDirectory(atPath: web.path) {
      let target = URL(fileURLWithPath: directory).appendingPathComponent(name)
      if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }
      try fm.copyItem(at: web.appendingPathComponent(name), to: target)
    }
  }
}
