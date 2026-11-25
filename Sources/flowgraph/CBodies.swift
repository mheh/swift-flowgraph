import Foundation

/// Reads the bodies of one C, C++, or Objective-C file: the outline of each function that the index defines there.
/// It reads the text with no compiler, so it needs no flag of the build: a macro is a call, and each arm of an `#if` is read.
struct CBodyReader {
  private let bytes: [UInt8]
  private let tokens: [CToken]
  private let owner: Int
  private var i: Int
  private var extents: Extents

  private static let caseKind = stepKinds.firstIndex(of: "case")!
  private static let defaultKind = stepKinds.firstIndex(of: "default")!
  private static let typeWords: Set<String> = ["struct", "union", "enum", "class"]

  /// `definitions` has each place of the file where a function is defined, with its nodes: one for each binary that compiles the file.
  static func read(path: String, definitions: [(place: Place, nodes: [Int])], uses: [Site]) -> [Int: Outline] {
    guard let data = FileManager.default.contents(atPath: path) else { return [:] }
    let bytes = [UInt8](data)
    let tokens = CConditionals.resolved(CLexer.tokens(of: bytes), compiledLines: Set(uses.map(\.line) + definitions.map(\.place.line)))
    var tokenAt: [Int64: Int] = [:]
    for (index, t) in tokens.enumerated() { tokenAt[Extents.key(t.line, t.column)] = index }
    var outlines: [Int: Outline] = [:]
    // The nodes of one place are in the same order all over the file, so each position of that order gets its own extents.
    var extents: [Extents] = []
    var position: [Int: Int] = [:]
    for (place, nodes) in definitions {
      guard let name = tokenAt[Extents.key(place.line, place.column)], let (open, initializers) = bodyStart(after: name, in: tokens), let close = closing(open, in: tokens) else { continue }
      for (k, node) in nodes.enumerated() where outlines[node] == nil {
        while extents.count <= k { extents.append(Extents()) }
        var reader = CBodyReader(bytes: bytes, tokens: tokens, owner: node, i: open + 1, extents: extents[k])
        let steps = initializers.map { reader.initializer($0) } + reader.list(inArm: false)
        extents[k] = reader.extents
        extents[k].add(from: Extents.key(place.line, place.column), to: Extents.key(tokens[close].endLine, tokens[close].endColumn), owner: node, step: nil)
        outlines[node] = Outline(flags: 0, endLine: tokens[close].line, steps: steps)
        position[node] = k
      }
    }
    for k in extents.indices { extents[k].nest() }
    for site in uses where site.column > 0 {
      for k in position[site.key.from].map({ [$0] }) ?? Array(extents.indices) { extents[k].innermost(site.line, site.column)?.step?.add(site) }
    }
    return outlines
  }

  // --- where a body is

  /// The `{` of the body of the function whose name is the token `name`, or nil for a declaration. With it, each member that a constructor sets before its body.
  private static func bodyStart(after name: Int, in tokens: [CToken]) -> (open: Int, initializers: [Range<Int>])? {
    var j = name
    var initializers: [Range<Int>] = []
    if tokens[j].isWord("operator") {
      j += 1
      while j < tokens.count, !tokens[j].isPunct("(") { j += 1 }
      if j + 2 < tokens.count, tokens[j + 1].isPunct(")"), tokens[j + 2].isPunct("(") { j += 2 }
    }
    var depth = 0
    while j < tokens.count {
      let t = tokens[j]
      if t.kind == .punct, t.text == "(" || t.text == "[" {
        depth += 1
      } else if t.kind == .punct, t.text == ")" || t.text == "]" {
        depth -= 1
      } else if t.kind == .punct, depth == 0 {
        switch t.text {
        case "{": return (j, initializers)
        case ";", "=", "}": return nil
        case ":":
          // The initializers of a constructor, each a name and one group, or one part of an Objective-C selector. An `#if` can stand between two.
          repeat {
            j += 1
            while j < tokens.count, tokens[j].kind == .directive { j += 1 }
            let from = j
            while j < tokens.count, !(tokens[j].isPunct("(") || tokens[j].isPunct("{") || tokens[j].isPunct(";")) { j += 1 }
            guard let close = closing(j, in: tokens) else { return nil }
            if tokens[from].kind == .word { initializers.append(from..<(close + 1)) }
            j = close + 1
            while j < tokens.count, tokens[j].kind == .directive { j += 1 }
          } while j < tokens.count && tokens[j].isPunct(",")
          continue
        default: break
        }
      }
      j += 1
    }
    return nil
  }

  private static func closing(_ open: Int, in tokens: [CToken]) -> Int? {
    guard open < tokens.count, tokens[open].kind == .punct, ["(", "[", "{"].contains(tokens[open].text) else { return nil }
    var depth = 0
    for j in open..<tokens.count where tokens[j].kind == .punct {
      switch tokens[j].text {
      case "(", "[", "{": depth += 1
      case ")", "]", "}":
        depth -= 1
        if depth == 0 { return j }
      default: break
      }
    }
    return nil
  }

  // --- the steps of a block

  private var more: Bool { i < tokens.count }
  private var token: CToken { tokens[i] }
  private func next(is text: String) -> Bool { i + 1 < tokens.count && tokens[i + 1].isPunct(text) }
  private func start(_ t: CToken) -> Int64 { Extents.key(t.line, t.column) }
  private var consumed: Int64 { Extents.key(tokens[i - 1].endLine, tokens[i - 1].endColumn) }

  /// The first line of the tokens of a range, as the page shows it, and the hash of them all when they have more than that.
  private func text(_ range: Range<Int>, limit: Int = 110) -> (shown: String, hash: UInt32) {
    guard !range.isEmpty else { return ("", 0) }
    var shown = ""
    var space = false
    var cut = tokens[range.lowerBound].line != tokens[range.upperBound - 1].endLine
    for c in String(decoding: bytes[tokens[range.lowerBound].start..<tokens[range.upperBound - 1].end], as: UTF8.self) {
      if c == "\n" || c == "\r\n" { break }
      if c == " " || c == "\t" {
        space = true
        continue
      }
      if space, !shown.isEmpty { shown.append(" ") }
      space = false
      shown.append(c)
      if shown.count >= limit {
        shown.append("…")
        cut = true
        break
      }
    }
    guard cut else { return (shown, 0) }
    var hash: UInt32 = 2_166_136_261
    for t in tokens[range] where t.kind != .directive {
      for byte in bytes[t.start..<t.end] { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
      hash = (hash ^ 32) &* 16_777_619
    }
    return (shown, hash)
  }

  private func step(_ kind: String, at first: CToken, _ range: Range<Int>, prefix: String = "") -> Step {
    let (shown, hash) = text(range)
    let step = Step(kind, first.line, prefix + shown)
    step.hash = hash
    return step
  }

  private mutating func close(_ step: Step, from first: CToken) -> Step {
    extents.add(from: start(first), to: consumed, owner: owner, step: step)
    return step
  }

  private mutating func initializer(_ range: Range<Int>) -> Step {
    let made = step("stmt", at: tokens[range.lowerBound], range)
    let last = tokens[range.upperBound - 1]
    extents.add(from: start(tokens[range.lowerBound]), to: Extents.key(last.endLine, last.endColumn), owner: owner, step: made)
    return made
  }

  /// The statements up to the `}` of the block, or up to the end of the arm of an `#if`. The statements after a `case` are its children.
  private mutating func list(inArm: Bool) -> [Step] {
    var out: [Step] = []
    var arm: (step: Step, first: CToken)?
    while more, !token.isPunct("}") {
      if token.endsArm {
        if inArm { break }
        i += 1
        continue
      }
      let first = token
      for step in statement() {
        if step.kind == CBodyReader.caseKind || step.kind == CBodyReader.defaultKind {
          if let arm { extents.add(from: start(arm.first), to: start(first), owner: owner, step: arm.step) }
          arm = (step, first)
          out.append(step)
        } else if let arm {
          arm.step.children.append(step)
        } else {
          out.append(step)
        }
      }
    }
    if let arm { extents.add(from: start(arm.first), to: consumed, owner: owner, step: arm.step) }
    return out
  }

  /// The tokens between a `(` at the place of the reader and its `)`. The reader goes past the `)`.
  private mutating func parens() -> Range<Int> {
    guard more, token.isPunct("("), let close = CBodyReader.closing(i, in: tokens) else { return i..<i }
    defer { i = close + 1 }
    return (i + 1)..<close
  }

  private mutating func body() -> [Step] { more && !token.isPunct("}") && !token.endsArm ? statement() : [] }

  private mutating func branch(_ kind: String, at first: CToken, _ header: Range<Int>) -> [Step] {
    let made = step(kind, at: first, header)
    made.children = body()
    return [close(made, from: first)]
  }

  private mutating func statement() -> [Step] {
    let first = token
    if first.opensArm { return conditional() }
    if first.kind == .punct {
      switch first.text {
      case "{":
        i += 1
        let inner = list(inArm: false)
        if more { i += 1 }
        return inner
      case ";":
        i += 1
        return []
      case "@" where i + 1 < tokens.count && tokens[i + 1].kind == .word:
        i += 1
        return statement()
      default: break
      }
    }
    if first.kind == .word {
      if next(is: ":"), first.text != "default" {
        i += 2
        return body()
      }
      switch first.text {
      case "if", "while", "for", "switch", "catch":
        i += 1
        while more, token.kind == .word { i += 1 }
        return branch(first.text, at: first, parens())
      case "else":
        i += 1
        if more, token.isWord("if") {
          i += 1
          while more, token.kind == .word { i += 1 }
          return branch("else if", at: first, parens())
        }
        return branch("else", at: first, i..<i)
      case "try":
        i += 1
        return branch("do", at: first, i..<i)
      case "do":
        i += 1
        let children = body()
        var header = i..<i
        if more, token.isWord("while") {
          i += 1
          header = parens()
          if more, token.isPunct(";") { i += 1 }
        }
        let made = step("repeat", at: first, header, prefix: "while ")
        made.children = children
        return [close(made, from: first)]
      case "case":
        i += 1
        let from = i
        var questions = 0
        while more, !token.isPunct("}"), !token.isPunct(";"), !(token.isPunct(":") && questions == 0) {
          if token.isPunct("?") { questions += 1 } else if token.isPunct(":") { questions -= 1 }
          i += 1
        }
        let made = step("case", at: first, from..<i)
        if more, token.isPunct(":") { i += 1 }
        return [made]
      case "default" where next(is: ":"):
        i += 2
        return [Step("default", first.line, "")]
      case "return", "throw":
        i += 1
        return simple(first.text, at: first)
      default:
        // A macro that takes a block, as `EACH(x) { … }` or `GUARDED { … }`.
        if next(is: "{"), !CBodyReader.typeWords.contains(first.text) {
          i += 1
          return branch("stmt", at: first, (i - 1)..<i)
        }
        if next(is: "("), let end = CBodyReader.closing(i + 1, in: tokens), end + 1 < tokens.count, tokens[end + 1].isPunct("{") {
          let from = i
          i = end + 1
          return branch("stmt", at: first, from..<i)
        }
      }
    }
    return simple("stmt", at: first)
  }

  /// One statement to its `;`. It also ends before a `}` that it did not open, and before the end of the arm of an `#if`.
  private mutating func simple(_ kind: String, at first: CToken) -> [Step] {
    let from = i
    var depth = 0
    var end = i
    while more {
      let t = token
      if t.kind == .punct {
        if t.text == "(" || t.text == "[" || t.text == "{" { depth += 1 }
        if t.text == ")" || t.text == "]" || t.text == "}" {
          if depth == 0 { break }
          depth -= 1
        }
        if t.text == ";", depth == 0 {
          i += 1
          break
        }
      } else if t.endsArm, depth == 0 {
        break
      }
      i += 1
      end = i
    }
    guard i > from else {
      i += 1
      return []
    }
    return [close(step(kind, at: first, from..<end), from: first)]
  }

  /// One step for each arm of an `#if`.
  private mutating func conditional() -> [Step] {
    var out: [Step] = []
    while more, token.kind == .directive, token.text != "endif" {
      let head = token
      i += 1
      let made = Step("#if", head.line, head.text == "else" ? "else" : head.text == "ifndef" ? "!" + head.detail : head.detail)
      made.children = list(inArm: true)
      extents.add(from: start(head), to: more ? start(token) : consumed, owner: owner, step: made)
      out.append(made)
    }
    if more, token.kind == .directive { i += 1 }
    return out
  }
}
