import Foundation
import SwiftParser
import SwiftSyntax

/// Reads the bodies of one Swift file: the outline of each function, and the closures that the project hands to other modules.
struct BodyReader {
  let file: Int
  let converter: SourceLocationConverter
  let rules: EntryRules
  /// The calls and the function references of the file by their place, from the index.
  private var calls: [Int64: Int] = [:]
  private var functionRefs: [Int64: Int] = [:]
  /// Each step with the extent of its source, and the node that owns its outline. The extents are nested or apart.
  private var extents: [(start: Int64, end: Int64, owner: Int, step: Step?)] = []
  private(set) var outlines: [Int: Outline] = [:]
  private var closureNodes = Set<Int>()

  private static func key(_ line: Int, _ column: Int) -> Int64 { Int64(line) << 20 | Int64(column) }
  private func start(_ node: some SyntaxProtocol) -> SourceLocation { node.startLocation(converter: converter) }
  private func key(startOf node: some SyntaxProtocol) -> Int64 { let l = start(node); return BodyReader.key(l.line, l.column) }
  private func key(endOf node: some SyntaxProtocol) -> Int64 { let l = node.endLocation(converter: converter); return BodyReader.key(l.line, l.column) }

  /// The first line of a node, as the page shows it. When the node has more than that, its whole text goes into the hash of the step that is made next,
  /// so that a change past the first line still makes another step.
  private mutating func text(_ node: (some SyntaxProtocol)?, limit: Int = 110) -> String {
    guard let node else { return "" }
    let shown = BodyReader.shown(node, limit: limit)
    if shown.hasSuffix("…") || node.trimmedDescription.contains("\n") {
      let tokens = TokenText(viewMode: .sourceAccurate)
      if pending != 0 { tokens.hash = pending }
      tokens.walk(node)
      pending = tokens.hash
    }
    return shown
  }
  private var pending: UInt32 = 0

  private static func shown(_ node: (some SyntaxProtocol)?, limit: Int = 110) -> String {
    guard let node else { return "" }
    var out = ""
    var space = false
    for c in node.trimmedDescription {
      if c == "\n" { break }
      if c == " " || c == "\t" {
        space = true
        continue
      }
      if space, !out.isEmpty { out.append(" ") }
      space = false
      out.append(c)
      if out.count >= limit {
        out.append("…")
        return out
      }
    }
    return out
  }

  /// Reads one file. It must run after every file was read into the graph and before `finish`.
  static func read(path: String, file: Int, shown: String, rules: EntryRules, into graph: inout Graph) -> [Int: Outline] {
    guard let source = try? String(contentsOfFile: path, encoding: .utf8) else { return [:] }
    let tree = Parser.parse(source: source)
    var reader = BodyReader(file: file, converter: SourceLocationConverter(fileName: path, tree: tree), rules: rules)
    let calls = edgeKinds.firstIndex(of: "calls")!
    let refs = edgeKinds.firstIndex(of: "refs")!
    for site in graph.uses(in: file) where site.column > 0 {
      if site.key.kind == calls { reader.calls[key(site.line, site.column)] = site.key.to }
      if site.key.kind == refs { reader.functionRefs[key(site.line, site.column)] = site.key.to }
    }
    let finder = DeclFinder(viewMode: .sourceAccurate)
    finder.walk(tree)
    for decl in finder.found { reader.outline(decl, graph: &graph) }
    if shown.hasSuffix("/main.swift") || shown == "main.swift", let top = graph.topLevel(of: shown) {
      var outline = Outline()
      outline.steps = reader.steps(tree.statements, owner: top, graph: &graph)
      outline.endLine = reader.converter.location(for: tree.endPosition).line
      reader.outlines[top] = outline
      reader.extents.append((0, .max, top, nil))
    }
    reader.attach(to: &graph)
    return reader.outlines
  }

  /// Gives each use of the file to the innermost step that holds it, and the uses inside a new closure node to that node.
  private mutating func attach(to graph: inout Graph) {
    extents.sort { ($0.start, -$0.end) < ($1.start, -$1.end) }
    // The parent of an extent is the nearest one before it that holds it.
    var parent = [Int](repeating: -1, count: extents.count)
    var stack: [Int] = []
    for i in extents.indices {
      while let top = stack.last, extents[top].end < extents[i].end || extents[top].end <= extents[i].start { stack.removeLast() }
      parent[i] = stack.last ?? -1
      stack.append(i)
    }
    func innermost(_ line: Int, _ column: Int) -> Int? {
      let k = BodyReader.key(line, column)
      var low = 0
      var high = extents.count
      while low < high {
        let mid = (low + high) / 2
        if extents[mid].start <= k { low = mid + 1 } else { high = mid }
      }
      var i = low - 1
      while i >= 0, extents[i].end <= k { i = parent[i] }
      return i >= 0 ? i : nil
    }
    let closures = closureNodes
    graph.move(usesIn: file) { site in
      guard let i = innermost(site.line, site.column), closures.contains(extents[i].owner), extents[i].owner != site.key.to else { return nil }
      return extents[i].owner
    }
    for site in graph.uses(in: file) where site.column > 0 {
      guard let i = innermost(site.line, site.column), let step = extents[i].step else { continue }
      if !step.refs.contains(where: { $0.to == site.key.to && $0.kind == site.key.kind }) { step.refs.append((site.key.to, site.key.kind)) }
    }
  }

  // --- the declarations that have a body

  private mutating func outline(_ decl: Syntax, graph: inout Graph) {
    func node(at token: TokenSyntax) -> Int? {
      let l = start(token)
      return graph.definition(at: Place(file: file, line: l.line, column: l.column))
    }
    func effects(async: TokenSyntax?, throws clause: ThrowsClauseSyntax?) -> Int {
      (async != nil ? Outline.isAsync : 0) | (clause != nil && clause?.throwsSpecifier.tokenKind != .keyword(.rethrows) ? Outline.canThrow : 0)
    }
    var owner: Int?
    var flags = 0
    var body: CodeBlockItemListSyntax?
    var accessors: AccessorBlockSyntax?
    if let f = decl.as(FunctionDeclSyntax.self) {
      owner = node(at: f.name)
      // A declaration with no body names code of another binary: the project calls it, and nothing starts the project there.
      if f.body == nil, let owner { graph.unmarkEntry(owner) }
      flags = effects(async: f.signature.effectSpecifiers?.asyncSpecifier, throws: f.signature.effectSpecifiers?.throwsClause)
      body = f.body?.statements
    } else if let f = decl.as(InitializerDeclSyntax.self) {
      owner = node(at: f.initKeyword)
      flags = effects(async: f.signature.effectSpecifiers?.asyncSpecifier, throws: f.signature.effectSpecifiers?.throwsClause)
      body = f.body?.statements
    } else if let f = decl.as(DeinitializerDeclSyntax.self) {
      owner = node(at: f.deinitKeyword)
      body = f.body?.statements
    } else if let f = decl.as(SubscriptDeclSyntax.self) {
      owner = node(at: f.subscriptKeyword)
      accessors = f.accessorBlock
    } else if let binding = decl.as(PatternBindingSyntax.self), let name = binding.pattern.as(IdentifierPatternSyntax.self) {
      owner = node(at: name.identifier)
      accessors = binding.accessorBlock
    }
    guard let owner, outlines[owner] == nil else { return }
    var outline = Outline(flags: flags, endLine: decl.endLocation(converter: converter).line)
    if let body {
      outline.steps = steps(body, owner: owner, graph: &graph)
    } else if let accessors {
      switch accessors.accessors {
      case .getter(let list):
        outline.steps = steps(list, owner: owner, graph: &graph)
      case .accessors(let list):
        for accessor in list {
          guard let block = accessor.body else { continue }
          let step = Step("accessor", start(accessor).line, accessor.accessorSpecifier.text)
          step.children = steps(block.statements, owner: owner, graph: &graph)
          extents.append((key(startOf: accessor), key(endOf: accessor), owner, step))
          outline.steps.append(step)
          if accessor.accessorSpecifier.tokenKind == .keyword(.get) {
            outline.flags |= effects(async: accessor.effectSpecifiers?.asyncSpecifier, throws: accessor.effectSpecifiers?.throwsClause)
          }
        }
      }
    } else {
      return
    }
    extents.append((key(startOf: decl), key(endOf: decl), owner, nil))
    outlines[owner] = outline
  }

  // --- the steps of a block

  private mutating func steps(_ items: CodeBlockItemListSyntax, owner: Int, graph: inout Graph) -> [Step] {
    var out: [Step] = []
    for item in items { out += steps(of: Syntax(item.item), owner: owner, graph: &graph) }
    return out
  }

  private mutating func made(_ kind: String, _ node: some SyntaxProtocol, _ text: String, owner: Int) -> Step {
    let step = Step(kind, start(node).line, text)
    step.hash = pending
    pending = 0
    extents.append((key(startOf: node), key(endOf: node), owner, step))
    return step
  }

  /// The steps of one statement. A branch gives one step for each of its arms.
  private mutating func steps(of node: Syntax, owner: Int, graph: inout Graph) -> [Step] {
    if let s = node.as(ExpressionStmtSyntax.self) { return steps(of: Syntax(s.expression), owner: owner, graph: &graph) }
    if let s = node.as(LabeledStmtSyntax.self) { return steps(of: Syntax(s.statement), owner: owner, graph: &graph) }
    if let s = node.as(GuardStmtSyntax.self) {
      let step = made("guard", s, text(s.conditions), owner: owner)
      step.children = inner(Syntax(s.conditions), of: step, owner: owner, graph: &graph) + steps(s.body.statements, owner: owner, graph: &graph)
      return [step]
    }
    if let s = node.as(IfExprSyntax.self) { return ifSteps(s, first: true, owner: owner, graph: &graph) }
    if let s = node.as(SwitchExprSyntax.self) {
      let step = made("switch", s, text(s.subject), owner: owner)
      step.children = inner(Syntax(s.subject), of: step, owner: owner, graph: &graph)
      for element in s.cases {
        guard case .switchCase(let c) = element else { continue }
        let isDefault = c.label.is(SwitchDefaultLabelSyntax.self)
        let arm = made(isDefault ? "default" : "case", c, isDefault ? "" : text(c.label).replacingOccurrences(of: #"^case |:$"#, with: "", options: .regularExpression), owner: owner)
        arm.children = steps(c.statements, owner: owner, graph: &graph)
        step.children.append(arm)
      }
      return [step]
    }
    if let s = node.as(ForStmtSyntax.self) {
      let step = made("for", s, text(s.pattern) + " in " + text(s.sequence) + (s.whereClause.map { " " + text($0) } ?? ""), owner: owner)
      step.children = inner(Syntax(s.sequence), of: step, owner: owner, graph: &graph) + steps(s.body.statements, owner: owner, graph: &graph)
      return [step]
    }
    if let s = node.as(WhileStmtSyntax.self) {
      let step = made("while", s, text(s.conditions), owner: owner)
      step.children = inner(Syntax(s.conditions), of: step, owner: owner, graph: &graph) + steps(s.body.statements, owner: owner, graph: &graph)
      return [step]
    }
    if let s = node.as(RepeatStmtSyntax.self) {
      let step = made("repeat", s, "while " + text(s.condition), owner: owner)
      step.children = steps(s.body.statements, owner: owner, graph: &graph) + inner(Syntax(s.condition), of: step, owner: owner, graph: &graph)
      return [step]
    }
    if let s = node.as(DoStmtSyntax.self) {
      let step = made("do", s.body, "", owner: owner)
      step.children = steps(s.body.statements, owner: owner, graph: &graph)
      var out = [step]
      for clause in s.catchClauses {
        let arm = made("catch", clause, text(clause.catchItems), owner: owner)
        arm.children = steps(clause.body.statements, owner: owner, graph: &graph)
        out.append(arm)
      }
      return out
    }
    if let s = node.as(DeferStmtSyntax.self) {
      let step = made("defer", s, "", owner: owner)
      step.children = steps(s.body.statements, owner: owner, graph: &graph)
      return [step]
    }
    if let s = node.as(ReturnStmtSyntax.self) {
      let step = made("return", s, text(s.expression), owner: owner)
      if let e = s.expression { step.children = inner(Syntax(e), of: step, owner: owner, graph: &graph) }
      return [step]
    }
    if let s = node.as(ThrowStmtSyntax.self) {
      let step = made("throw", s, text(s.expression), owner: owner)
      step.children = inner(Syntax(s.expression), of: step, owner: owner, graph: &graph)
      return [step]
    }
    if let s = node.as(FunctionDeclSyntax.self) {
      // A function inside a function is no symbol of the index: its body is part of the outline that holds it.
      let step = made("func", s, s.name.text, owner: owner)
      if let body = s.body { step.children = steps(body.statements, owner: owner, graph: &graph) }
      return [step]
    }
    if let s = node.as(IfConfigDeclSyntax.self) {
      var out: [Step] = []
      for clause in s.clauses {
        guard case .statements(let list)? = clause.elements else { continue }
        let step = made("#if", clause, clause.condition.map { text($0) } ?? "else", owner: owner)
        step.children = steps(list, owner: owner, graph: &graph)
        out.append(step)
      }
      return out
    }
    // A type inside a function is read as a declaration of the file.
    if node.is(StructDeclSyntax.self) || node.is(ClassDeclSyntax.self) || node.is(EnumDeclSyntax.self) || node.is(ActorDeclSyntax.self)
      || node.is(ExtensionDeclSyntax.self) || node.is(ProtocolDeclSyntax.self) || node.is(TypeAliasDeclSyntax.self)
    {
      return []
    }
    let step = made("stmt", node, text(node), owner: owner)
    step.children = inner(node, of: step, owner: owner, graph: &graph)
    return [step]
  }

  private mutating func ifSteps(_ s: IfExprSyntax, first: Bool, owner: Int, graph: inout Graph) -> [Step] {
    let step = made(first ? "if" : "else if", s, text(s.conditions), owner: owner)
    step.children = inner(Syntax(s.conditions), of: step, owner: owner, graph: &graph) + steps(s.body.statements, owner: owner, graph: &graph)
    switch s.elseBody {
    case .ifExpr(let next)?:
      return [step] + ifSteps(next, first: false, owner: owner, graph: &graph)
    case .codeBlock(let block)?:
      let arm = made("else", block, "", owner: owner)
      arm.children = steps(block.statements, owner: owner, graph: &graph)
      return [step, arm]
    case nil:
      return [step]
    }
  }

  /// What one expression holds below its own level: the closures, and the branches that are expressions.
  /// It also sets the flags of the step, and finds the closures and the functions that go to another module.
  private mutating func inner(_ node: Syntax, of step: Step, owner: Int, graph: inout Graph) -> [Step] {
    let scan = ExpressionScan(viewMode: .sourceAccurate)
    scan.walk(node)
    step.flags |= scan.flags
    var handed: [SyntaxIdentifier: String] = [:]
    for call in scan.calls {
      guard let name = BodyReader.calledName(call.calledExpression), let target = calls[key(startOf: name)],
        graph.takesHandOff(target), rules.allows(module: graph.nodes[target].module, name: graph.nodes[target].name)
      else { continue }
      let label = BodyReader.label(of: call, name: name.text)
      // A closure with an argument label is named with it, which tells two closures of one call apart.
      for argument in call.arguments {
        guard let closure = argument.expression.as(ClosureExprSyntax.self) else { continue }
        handed[closure.id] = argument.label.map { BodyReader.label(of: call, name: name.text, closure: $0.text) } ?? label
      }
      if let trailing = call.trailingClosure { handed[trailing.id] = label }
      for more in call.additionalTrailingClosures { handed[more.closure.id] = BodyReader.label(of: call, name: name.text, closure: more.label.text) }
      // A function that is passed by its name is an entry point too.
      for argument in call.arguments {
        guard let name = BodyReader.calledName(argument.expression), let passed = functionRefs[key(startOf: name)], !graph.nodes[passed].external else { continue }
        graph.markEntry(passed, label: label)
      }
    }
    var out: [Step] = []
    for found in scan.nested {
      if let closure = found.as(ClosureExprSyntax.self) {
        if let label = handed[closure.id] {
          let id = graph.addClosure(label: label, file: file, line: start(closure).line, owner: owner)
          closureNodes.insert(id)
          var outline = Outline(flags: 0, endLine: closure.endLocation(converter: converter).line)
          outline.steps = steps(closure.statements, owner: id, graph: &graph)
          outlines[id] = outline
          extents.append((key(startOf: closure), key(endOf: closure), id, nil))
          // The step has no extent of its own, so no use of the file lands on it. It names the closure node.
          let entry = Step("entry", start(closure).line, label)
          entry.refs = [(id, edgeKinds.firstIndex(of: "refs")!)]
          out.append(entry)
        } else {
          let inside = made("closure", closure, closure.signature.map { text($0) } ?? "", owner: owner)
          inside.children = steps(closure.statements, owner: owner, graph: &graph)
          out.append(inside)
        }
      } else {
        out += steps(of: found, owner: owner, graph: &graph)
      }
    }
    return out
  }

  /// The token that names what a call calls: `name` of `name(…)` and of `base.name(…)`.
  private static func calledName(_ expression: ExprSyntax) -> TokenSyntax? {
    if let e = expression.as(DeclReferenceExprSyntax.self) { return e.baseName }
    if let e = expression.as(MemberAccessExprSyntax.self) { return e.declName.baseName }
    if let e = expression.as(GenericSpecializationExprSyntax.self) { return calledName(e.expression) }
    if let e = expression.as(OptionalChainingExprSyntax.self) { return calledName(e.expression) }
    if let e = expression.as(ForceUnwrapExprSyntax.self) { return calledName(e.expression) }
    return nil
  }

  /// The name of a call with its literal arguments, which tell two calls of the same function apart.
  private static func label(of call: FunctionCallExprSyntax, name: String, closure: String? = nil) -> String {
    var literals = call.arguments.compactMap { argument -> String? in
      let e = argument.expression
      guard e.is(StringLiteralExprSyntax.self) || e.is(IntegerLiteralExprSyntax.self) || (e.as(MemberAccessExprSyntax.self)?.base == nil && e.is(MemberAccessExprSyntax.self)) else {
        return nil
      }
      return shown(e, limit: 40)
    }
    if let closure { literals.append(closure + ":") }
    return name + "(" + literals.joined(separator: ", ") + ")"
  }
}

/// The hash of the tokens of a node, with no comment and no white space. The statements of a block inside are left out, because they are steps of their own.
private final class TokenText: SyntaxVisitor {
  var hash: UInt32 = 2_166_136_261
  override func visit(_ node: CodeBlockItemListSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
  override func visit(_ token: TokenSyntax) -> SyntaxVisitorContinueKind {
    for byte in token.text.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
    hash = (hash ^ 32) &* 16_777_619
    return .skipChildren
  }
}

/// Finds each declaration that can have a body, at any depth.
private final class DeclFinder: SyntaxVisitor {
  var found: [Syntax] = []
  override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind { found.append(Syntax(node)); return .visitChildren }
  override func visit(_ node: InitializerDeclSyntax) -> SyntaxVisitorContinueKind { found.append(Syntax(node)); return .visitChildren }
  override func visit(_ node: DeinitializerDeclSyntax) -> SyntaxVisitorContinueKind { found.append(Syntax(node)); return .visitChildren }
  override func visit(_ node: SubscriptDeclSyntax) -> SyntaxVisitorContinueKind { found.append(Syntax(node)); return .visitChildren }
  override func visit(_ node: PatternBindingSyntax) -> SyntaxVisitorContinueKind {
    if node.accessorBlock != nil { found.append(Syntax(node)) }
    return .visitChildren
  }
}

/// Reads one expression to its closures and its branches, and does not go into them.
private final class ExpressionScan: SyntaxVisitor {
  var flags = 0
  var calls: [FunctionCallExprSyntax] = []
  var nested: [Syntax] = []
  override func visit(_ node: TryExprSyntax) -> SyntaxVisitorContinueKind {
    flags |= Step.hasTry
    if node.questionOrExclamationMark != nil { flags |= Step.tryIsHandled }
    return .visitChildren
  }
  override func visit(_ node: AwaitExprSyntax) -> SyntaxVisitorContinueKind { flags |= Step.hasAwait; return .visitChildren }
  override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind { calls.append(node); return .visitChildren }
  override func visit(_ node: ClosureExprSyntax) -> SyntaxVisitorContinueKind { nested.append(Syntax(node)); return .skipChildren }
  override func visit(_ node: IfExprSyntax) -> SyntaxVisitorContinueKind { nested.append(Syntax(node)); return .skipChildren }
  override func visit(_ node: SwitchExprSyntax) -> SyntaxVisitorContinueKind { nested.append(Syntax(node)); return .skipChildren }
}
