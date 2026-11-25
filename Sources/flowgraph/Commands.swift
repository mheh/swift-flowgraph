import Foundation

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

/// Runs a tool of the Swift toolchain: through xcrun where Xcode chooses the toolchain, and from the PATH elsewhere.
func runSwift(_ arguments: [String]) -> String? {
  FileManager.default.fileExists(atPath: "/usr/bin/xcrun") ? run("/usr/bin/xcrun", ["swift"] + arguments) : run("/usr/bin/env", ["swift"] + arguments)
}

