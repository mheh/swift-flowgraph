let stepKinds = [
  "stmt", "return", "throw", "guard", "if", "else if", "else", "switch", "case", "default", "for", "while", "repeat", "do", "catch", "defer",
  "closure", "func", "accessor", "#if", "entry",
]

/// One step of the outline of a body: a statement, or a branch with the steps inside it.
final class Step {
  let kind: Int
  let line: Int
  let text: String
  var flags = 0
  /// A hash of the whole text of the step, when the step has more text than its first line. 0: the text is the whole step.
  var hash: UInt32 = 0
  var children: [Step] = []
  /// What the step itself uses, with no child: the node and the kind of the edge.
  var refs: [(to: Int, kind: Int)] = []

  init(_ kind: String, _ line: Int, _ text: String) {
    self.kind = stepKinds.firstIndex(of: kind)!
    self.line = line
    self.text = text
  }

  static let hasTry = 1
  /// `try?` and `try!` do not pass the error on.
  static let tryIsHandled = 2
  static let hasAwait = 4
}

/// The outline of the body of one function, of one property with accessors, or of one closure that became a node.
struct Outline {
  static let isAsync = 1
  static let canThrow = 2
  var flags = 0
  var endLine = 0
  var steps: [Step] = []
}

/// The source extent of each step of one file, and the node that owns its outline. The extents are nested or apart.
struct Extents {
  private var list: [(start: Int64, end: Int64, owner: Int, step: Step?)] = []
  private var parent: [Int] = []

  static func key(_ line: Int, _ column: Int) -> Int64 { Int64(line) << 20 | Int64(column) }

  mutating func add(from start: Int64, to end: Int64, owner: Int, step: Step?) {
    list.append((start, end, owner, step))
  }

  /// Must run after the last `add` and before `innermost`.
  mutating func nest() {
    list.sort { ($0.start, -$0.end) < ($1.start, -$1.end) }
    parent = [Int](repeating: -1, count: list.count)
    var stack: [Int] = []
    for i in list.indices {
      while let top = stack.last, list[top].end < list[i].end || list[top].end <= list[i].start { stack.removeLast() }
      parent[i] = stack.last ?? -1
      stack.append(i)
    }
  }

  func innermost(_ line: Int, _ column: Int) -> (owner: Int, step: Step?)? {
    let k = Extents.key(line, column)
    var low = 0
    var high = list.count
    while low < high {
      let mid = (low + high) / 2
      if list[mid].start <= k { low = mid + 1 } else { high = mid }
    }
    var i = low - 1
    while i >= 0, list[i].end <= k { i = parent[i] }
    return i >= 0 ? (list[i].owner, list[i].step) : nil
  }
}

extension Step {
  func add(_ site: Site) {
    if !refs.contains(where: { $0.to == site.key.to && $0.kind == site.key.kind }) { refs.append((site.key.to, site.key.kind)) }
  }
}
