import Foundation

/// The file of a tool: a path as it is, and a plain name from the directories of PATH.
private func executable(_ tool: String) -> URL? {
  #if os(Windows)
  let separator: Character = ";", names = [tool + ".exe", tool]
  #else
  let separator: Character = ":", names = [tool]
  #endif
  if tool.contains("/") || tool.contains("\\") { return URL(fileURLWithPath: tool) }
  let directories = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: separator).map(String.init)
  for directory in directories {
    for name in names {
      let file = URL(fileURLWithPath: directory).appendingPathComponent(name)
      if FileManager.default.isExecutableFile(atPath: file.path) { return file }
    }
  }
  return nil
}

/// Where a tool of PATH is, or nil.
func find(tool: String) -> String? { executable(tool)?.path }

/// The output of one command, or nil when it fails.
func run(_ tool: String, _ arguments: [String]) -> String? {
  guard let file = executable(tool) else { return nil }
  let p = Process()
  p.executableURL = file
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

/// Runs one command in a directory, with its output on the error stream. True when it ends with no error.
func succeeds(_ tool: String, _ arguments: [String], in directory: String) -> Bool {
  guard let file = executable(tool) else { return false }
  let p = Process()
  p.executableURL = file
  p.arguments = arguments
  p.currentDirectoryURL = URL(fileURLWithPath: directory)
  p.standardOutput = FileHandle.standardError
  guard (try? p.run()) != nil else { return false }
  p.waitUntilExit()
  return p.terminationStatus == 0
}

/// Runs a command line as the user wrote it, with the shell of the platform.
func succeeds(shell command: String, in directory: String) -> Bool {
  #if os(Windows)
  return succeeds("cmd", ["/c", command], in: directory)
  #else
  return succeeds("/bin/sh", ["-c", command], in: directory)
  #endif
}

/// Runs a tool of the Swift toolchain: through xcrun where Xcode chooses the toolchain, and from PATH elsewhere.
func runSwift(_ arguments: [String]) -> String? {
  FileManager.default.fileExists(atPath: "/usr/bin/xcrun") ? run("/usr/bin/xcrun", ["swift"] + arguments) : run("swift", arguments)
}
