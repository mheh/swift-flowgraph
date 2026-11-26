import Foundation

/// Checks another commit of the project out and builds it, and points the options at that copy.
/// The worktree is in the cache directory and stays there, so the next build of the same ref is short.
func checkOut(_ ref: String, for options: inout Options) throws {
  guard let found = run("git", ["-C", options.project, "rev-parse", "--show-toplevel"]), !found.isEmpty else {
    throw Failure("--ref needs a git repository, and \(options.project) is not in one")
  }
  let top = URL(fileURLWithPath: found).resolvingSymlinksInPath().path
  let inside = options.project.hasPrefix(top) ? String(options.project.dropFirst(top.count)) : ""
  let name = URL(fileURLWithPath: options.project).lastPathComponent
  let tree = worktree(of: ref, name: name, top: top)
  if FileManager.default.fileExists(atPath: tree + "/.git") {
    guard succeeds("git", ["checkout", "--quiet", "--detach", ref], in: tree) else {
      throw Failure("git could not check out \(ref) in \(tree)")
    }
  } else {
    try FileManager.default.createDirectory(atPath: (tree as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    _ = succeeds("git", ["worktree", "prune"], in: top)
    guard succeeds("git", ["worktree", "add", "--quiet", "--detach", tree, ref], in: top) else {
      throw Failure("git could not make a worktree of \(ref)")
    }
  }
  log("building \(ref) in \(tree + inside): \(options.build)")
  guard succeeds(shell: options.build, in: tree + inside) else { throw Failure("the build of \(ref) failed: \(options.build)") }
  options.title = options.title ?? name
  options.project = URL(fileURLWithPath: tree + inside).resolvingSymlinksInPath().path
}

/// The directory of the worktree of one ref of one repository.
private func worktree(of ref: String, name: String, top: String) -> String {
  let safe = String(ref.map { $0.isLetter || $0.isNumber || "-_.".contains($0) ? $0 : "-" })
  let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
  return caches.appendingPathComponent("flowgraph/worktrees/\(name)-\(stableHash(top))/\(safe)").path
}
