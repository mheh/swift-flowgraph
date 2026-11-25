import Foundation

/// Which calls of other modules make an entry point of the function or the closure that they take.
/// A project can narrow the rule in `flowgraph.json`: `{ "entries": { "only": ["Module.*"], "except": ["Module.name"] } }`.
struct EntryRules {
  var only: [String] = []
  var except: [String] = []
  /// What the project marks for replacement: the name of a module, or `Module.name` of a symbol.
  var replace: [String] = []

  /// A project with no `flowgraph.json` has no rules. A file that the tool cannot read as rules is an error, because rules that are left out with no word give a wrong snapshot.
  init(project: String) throws {
    let path = project + "/flowgraph.json"
    guard let data = FileManager.default.contents(atPath: path) else { return }
    guard let top = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw Failure("\(path) is not a JSON object")
    }
    func list(_ value: Any?, _ key: String) throws -> [String] {
      guard let value else { return [] }
      guard let texts = value as? [String] else { throw Failure("\(path): \(key) must be a list of strings") }
      return texts
    }
    replace = try list(top["replace"], "replace")
    guard let value = top["entries"] else { return }
    guard let entries = value as? [String: Any] else { throw Failure("\(path): entries must be an object with only and except") }
    only = try list(entries["only"], "entries.only")
    except = try list(entries["except"], "entries.except")
  }

  /// A pattern is `Module.name`, and `*` stands for any text.
  private static func matches(_ pattern: String, _ text: String) -> Bool {
    let parts = pattern.split(separator: "*", omittingEmptySubsequences: false)
    guard parts.count > 1 else { return pattern == text }
    var rest = Substring(text)
    for (i, part) in parts.enumerated() {
      if i == 0 {
        guard rest.hasPrefix(part) else { return false }
        rest = rest.dropFirst(part.count)
      } else if i == parts.count - 1 {
        return rest.hasSuffix(part)
      } else if !part.isEmpty {
        guard let found = rest.range(of: part) else { return false }
        rest = rest[found.upperBound...]
      }
    }
    return true
  }

  func allows(module: String, name: String) -> Bool {
    let full = module + "." + name.prefix { $0 != "(" }
    if except.contains(where: { EntryRules.matches($0, full) }) { return false }
    return only.isEmpty || only.contains { EntryRules.matches($0, full) }
  }
}
