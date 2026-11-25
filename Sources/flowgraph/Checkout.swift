import Foundation

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
  let hash = stableHash(top2)
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
