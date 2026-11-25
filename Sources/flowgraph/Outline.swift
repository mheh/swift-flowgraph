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
