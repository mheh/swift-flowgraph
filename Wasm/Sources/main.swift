import Foundation

do {
  var options = try Options(Array(CommandLine.arguments.dropFirst()))
  options.fromIndex = true
  options.libIndexStore = "linked"
  try await makeSnapshot(options).write(to: URL(fileURLWithPath: options.out ?? "snapshot.json"))
} catch {
  log("flowgraph: \(error)")
  exit(1)
}
