struct CToken {
  enum Kind { case word, punct, literal, directive }
  var kind: Kind
  /// The word, the punctuation, or the name of the directive. A literal has none.
  var text: String
  /// The condition of an `#if` or an `#elif`.
  var detail = ""
  var start: Int
  var end: Int
  var line: Int
  var column: Int
  var endLine: Int
  var endColumn: Int

  func isPunct(_ s: String) -> Bool { kind == .punct && text == s }
  func isWord(_ s: String) -> Bool { kind == .word && text == s }
  var opensArm: Bool { kind == .directive && (text == "if" || text == "ifdef" || text == "ifndef") }
  var endsArm: Bool { kind == .directive && (text == "elif" || text == "else" || text == "endif") }
}

/// Splits the text of a C, C++, or Objective-C file into tokens, with no comment. It expands nothing.
struct CLexer {
  private let bytes: [UInt8]
  private var i = 0
  private var line = 1
  private var lineStart = 0
  private var tokens: [CToken] = []

  static func tokens(of bytes: [UInt8]) -> [CToken] {
    var lexer = CLexer(bytes: bytes)
    lexer.run()
    return lexer.tokens
  }

  private func at(_ offset: Int) -> UInt8 { offset < bytes.count ? bytes[offset] : 0 }
  private static func isWordByte(_ b: UInt8) -> Bool { b == 95 || b == 36 || b >= 128 || (b | 32 >= 97 && b | 32 <= 122) || isDigit(b) }
  private static func isDigit(_ b: UInt8) -> Bool { b >= 48 && b <= 57 }
  private func string(_ from: Int, _ to: Int) -> String { String(decoding: bytes[from..<to], as: UTF8.self) }

  private mutating func newline() {
    line += 1
    lineStart = i + 1
  }

  private mutating func add(_ kind: CToken.Kind, from start: Int, line startLine: Int, column: Int, detail: String = "") {
    let text = kind == .literal ? "" : kind == .directive ? detail : string(start, i)
    tokens.append(CToken(kind: kind, text: text, start: start, end: i, line: startLine, column: column, endLine: line, endColumn: i - lineStart + 1))
  }

  private mutating func run() {
    var lineHasToken = false
    while i < bytes.count {
      let b = bytes[i]
      let start = i
      let column = i - lineStart + 1
      let startLine = line
      if b == 10 {
        newline()
        lineHasToken = false
        i += 1
      } else if b == 32 || b == 9 || b == 13 || b == 12 || (b == 92 && at(i + 1) == 10) {
        i += 1
      } else if b == 47, at(i + 1) == 47 {
        while i < bytes.count, bytes[i] != 10 { i += 1 }
      } else if b == 47, at(i + 1) == 42 {
        skipBlockComment()
      } else if b == 35, !lineHasToken {
        directive()
      } else {
        lineHasToken = true
        if b == 34 || b == 39 {
          quoted(b)
          add(.literal, from: start, line: startLine, column: column)
        } else if CLexer.isDigit(b) || (b == 46 && CLexer.isDigit(at(i + 1))) {
          number()
          add(.literal, from: start, line: startLine, column: column)
        } else if CLexer.isWordByte(b) {
          while i < bytes.count, CLexer.isWordByte(bytes[i]) { i += 1 }
          if at(i) == 34, bytes[i - 1] == 82, i - start <= 3 {
            rawString()
            add(.literal, from: start, line: startLine, column: column)
          } else {
            add(.word, from: start, line: startLine, column: column)
          }
        } else {
          i += (b == 58 && at(i + 1) == 58) || (b == 45 && at(i + 1) == 62) ? 2 : 1
          add(.punct, from: start, line: startLine, column: column)
        }
      }
    }
  }

  private mutating func skipBlockComment() {
    i += 2
    while i < bytes.count, !(bytes[i] == 42 && at(i + 1) == 47) {
      if bytes[i] == 10 { newline() }
      i += 1
    }
    i = min(i + 2, bytes.count)
  }

  private mutating func quoted(_ quote: UInt8) {
    i += 1
    while i < bytes.count, bytes[i] != quote, bytes[i] != 10 { i += bytes[i] == 92 && at(i + 1) != 10 ? 2 : 1 }
    if at(i) == quote { i += 1 }
  }

  private mutating func number() {
    while i < bytes.count {
      let b = bytes[i]
      let exponent = bytes[i - 1] | 32
      if CLexer.isWordByte(b) || b == 46 || (b == 39 && CLexer.isWordByte(at(i + 1))) || ((b == 43 || b == 45) && (exponent == 101 || exponent == 112)) { i += 1 } else { break }
    }
  }

  /// `R"mark( … )mark"`, with `i` at the first quote.
  private mutating func rawString() {
    var open = i + 1
    while open < bytes.count, bytes[open] != 40, bytes[open] != 10 { open += 1 }
    let close = [41] + bytes[(i + 1)..<open] + [34]
    i = open
    while i < bytes.count, !(bytes[i] == 41 && bytes[i...].starts(with: close)) {
      if bytes[i] == 10 { newline() }
      i += 1
    }
    i = min(i + close.count, bytes.count)
  }

  /// One directive to the end of its line, with the lines that a backslash joins to it.
  private mutating func directive() {
    let start = i
    let column = i - lineStart + 1
    let startLine = line
    i += 1
    while at(i) == 32 || at(i) == 9 { i += 1 }
    let nameStart = i
    while i < bytes.count, CLexer.isWordByte(bytes[i]) { i += 1 }
    let name = string(nameStart, i)
    let restStart = i
    var restEnd = -1
    while i < bytes.count, bytes[i] != 10 {
      if bytes[i] == 92, at(i + 1) == 10 {
        if restEnd < 0 { restEnd = i }
        i += 1
        newline()
      } else if bytes[i] == 47, at(i + 1) == 47 || at(i + 1) == 42 {
        if restEnd < 0 { restEnd = i }
        if at(i + 1) == 42 { skipBlockComment() } else { while i < bytes.count, bytes[i] != 10 { i += 1 } }
        continue
      }
      i += 1
    }
    let rest = string(restStart, restEnd < 0 ? i : restEnd).split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\r" }).joined(separator: " ")
    add(.directive, from: start, line: startLine, column: column, detail: name)
    tokens[tokens.count - 1].detail = rest
  }
}

/// Decides how the outline shows each `#if`. A group whose arms each hold whole statements keeps its directives, and each arm becomes a step.
/// Of any other group only one arm stays, with no directive: the first one that the compiler read, which is one with a line that the index names.
/// With no such arm it is the first, or the next one after `#if 0`. No other directive stays.
struct CConditionals {
  private let tokens: [CToken]
  private let compiled: Set<Int>
  private var i = 0

  static func resolved(_ tokens: [CToken], compiledLines: Set<Int>) -> [CToken] {
    var reader = CConditionals(tokens: tokens, compiled: compiledLines)
    return reader.list(inGroup: false)
  }

  private mutating func list(inGroup: Bool) -> [CToken] {
    var out: [CToken] = []
    var parens = 0
    while i < tokens.count {
      let t = tokens[i]
      if t.opensArm {
        out += group(insideParens: parens != 0)
      } else if t.endsArm, inGroup {
        return out
      } else {
        if t.isPunct("(") { parens += 1 } else if t.isPunct(")") { parens -= 1 }
        if t.kind != .directive { out.append(t) }
        i += 1
      }
    }
    return out
  }

  private mutating func group(insideParens: Bool) -> [CToken] {
    var arms: [(head: CToken, body: [CToken])] = []
    var end: CToken?
    while i < tokens.count {
      let head = tokens[i]
      i += 1
      if head.text == "endif" {
        end = head
        break
      }
      arms.append((head, list(inGroup: true)))
    }
    if let end, !insideParens, arms.allSatisfy({ CConditionals.isBalanced($0.body) }) { return arms.flatMap { [$0.head] + $0.body } + [end] }
    let last = end?.line ?? tokens.last?.line ?? 0
    for (k, arm) in arms.enumerated() {
      let next = k + 1 < arms.count ? arms[k + 1].head.line : last
      if next > arm.head.line, (arm.head.line..<next).contains(where: compiled.contains) { return arm.body }
    }
    let first = arms.first?.head.text == "if" && arms.first?.head.detail == "0" ? arms.dropFirst().first : arms.first
    return first?.body ?? []
  }

  private static func isBalanced(_ tokens: [CToken]) -> Bool {
    var braces = 0
    var parens = 0
    for t in tokens where t.kind == .punct {
      switch t.text {
      case "{": braces += 1
      case "}": braces -= 1
      case "(": parens += 1
      case ")": parens -= 1
      default: break
      }
      if braces < 0 || parens < 0 { return false }
    }
    return braces == 0 && parens == 0
  }
}
