import Foundation
import SwiftParser
import SwiftSyntax

/// Reads the bodies of one Swift file: the outline of each function, and the closures that the project hands to other modules.
struct SwiftBodyReader {
  let file: Int
  let converter: SourceLocationConverter
  let rules: EntryRules
  /// The calls and the function references of the file by their place, from the index.
  private var calls: [Int64: Int] = [:]
  private var functionRefs: [Int64: Int] = [:]
  private var extents = Extents()
  private(set) var outlines: [Int: Outline] = [:]
  private var closureNodes = Set<Int>()

  private func start(_ node: some SyntaxProtocol) -> SourceLocation { node.startLocation(converter: converter) }
  private func key(startOf node: some SyntaxProtocol) -> Int64 { let l = start(node); return Extents.key(l.line, l.column) }
  private func key(endOf node: some SyntaxProtocol) -> Int64 { let l = node.endLocation(converter: converter); return Extents.key(l.line, l.column) }

  /// The first line of a node, as the page shows it. When the node has more than that, its whole text goes into the hash of the step that is made next,
  /// so that a change past the first line still makes another step.
  private mutating func text(_ node: (some SyntaxProtocol)?, limit: Int = 110) -> String {
    guard let node else { return "" }
    let shown = Step.firstLine(of: node.trimmedDescription, limit: limit)
    if shown.hasSuffix("…") || node.trimmedDescription.contains("\n") {
      let tokens = TokenText(viewMode: .sourceAccurate)
      if pending != 0 { tokens.hash.value = pending }
      tokens.walk(node)
      pending = tokens.hash.value
    }
    return shown
  }
  private var pending: UInt32 = 0

  /// Reads one file. It must run after every file was read into the graph and before `finish`.
  static func read(path: String, file: Int, shown: String, rules: EntryRules, into graph: inout Graph) -> [Int: Outline] {
    guard let source = try? String(contentsOfFile: path, encoding: .utf8) else { return [:] }
    let tree = Parser.parse(source: source)
    var reader = SwiftBodyReader(file: file, converter: SourceLocationConverter(fileName: path, tree: tree), rules: rules)
    let calls = edgeKinds.firstIndex(of: "calls")!
    let refs = edgeKinds.firstIndex(of: "refs")!
    for site in graph.uses(in: file) where site.column > 0 {
      if site.key.kind == calls { reader.calls[Extents.key(site.line, site.column)] = site.key.to }
      if site.key.kind == refs { reader.functionRefs[Extents.key(site.line, site.column)] = site.key.to }
    }
    let finder = DeclFinder(viewMode: .sourceAccurate)
    finder.walk(tree)
    for decl in finder.found { reader.outline(decl, graph: &graph) }
    if shown.hasSuffix("/main.swift") || shown == "main.swift", let top = graph.topLevel(of: shown) {
      var outline = Outline()
      outline.steps = reader.steps(tree.statements, owner: top, graph: &graph)
      outline.endLine = reader.converter.location(for: tree.endPosition).line
      reader.outlines[top] = outline
      reader.extents.add(from: 0, to: .max, owner: top, step: nil)
    }
    reader.attach(to: &graph)
    return reader.outlines
  }

  /// Gives each use of the file to the innermost step that holds it, and the uses inside a new closure node to that node.
  private mutating func attach(to graph: inout Graph) {
    extents.nest()
    let closures = closureNodes
    graph.move(usesIn: file) { site in
      guard let owner = extents.innermost(site.line, site.column)?.owner, closures.contains(owner), owner != site.key.to else { return nil }
      return owner
    }
    for site in graph.uses(in: file) where site.column > 0 {
      extents.innermost(site.line, site.column)?.step?.add(site)
    }
  }

  // --- the declarations that have a body

  private static func effects(_ specifiers: (async: TokenSyntax?, throws: ThrowsClauseSyntax?)) -> Int {
    let canThrow = specifiers.throws != nil && specifiers.throws?.throwsSpecifier.tokenKind != .keyword(.rethrows)
    return (specifiers.async != nil ? Outline.isAsync : 0) | (canThrow ? Outline.canThrow : 0)
  }

  private mutating func outline(_ decl: Syntax, graph: inout Graph) {
    func node(at token: TokenSyntax) -> Int? {
      let l = start(token)
      return graph.definition(at: Place(file: file, line: l.line, column: l.column))
    }
    var owner: Int?
    var flags = 0
    var body: CodeBlockItemListSyntax?
    var accessors: AccessorBlockSyntax?
    if let f = decl.as(FunctionDeclSyntax.self) {
      owner = node(at: f.name)
      // A declaration with no body names code of another binary: the project calls it, and nothing starts the project there.
      if f.body == nil, let owner { graph.unmarkEntry(owner) }
      flags = SwiftBodyReader.effects((f.signature.effectSpecifiers?.asyncSpecifier, f.signature.effectSpecifiers?.throwsClause))
      body = f.body?.statements
    } else if let f = decl.as(InitializerDeclSyntax.self) {
      owner = node(at: f.initKeyword)
      flags = SwiftBodyReader.effects((f.signature.effectSpecifiers?.asyncSpecifier, f.signature.effectSpecifiers?.throwsClause))
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
    guard let owner, outlines[owner] == nil, body != nil || accessors != nil else { return }
    var outline = Outline(flags: flags, endLine: decl.endLocation(converter: converter).line)
    if let body {
      outline.steps = steps(body, owner: owner, graph: &graph)
    } else if let accessors {
      read(accessors, into: &outline, owner: owner, graph: &graph)
    }
    extents.add(from: key(startOf: decl), to: key(endOf: decl), owner: owner, step: nil)
    outlines[owner] = outline
  }

  private mutating func read(_ block: AccessorBlockSyntax, into outline: inout Outline, owner: Int, graph: inout Graph) {
    switch block.accessors {
    case .getter(let list):
      outline.steps = steps(list, owner: owner, graph: &graph)
    case .accessors(let list):
      for accessor in list {
        guard let body = accessor.body else { continue }
        let step = Step("accessor", start(accessor).line, accessor.accessorSpecifier.text)
        step.children = steps(body.statements, owner: owner, graph: &graph)
        extents.add(from: key(startOf: accessor), to: key(endOf: accessor), owner: owner, step: step)
        outline.steps.append(step)
        if accessor.accessorSpecifier.tokenKind == .keyword(.get) {
          outline.flags |= SwiftBodyReader.effects((accessor.effectSpecifiers?.asyncSpecifier, accessor.effectSpecifiers?.throwsClause))
        }
      }
    }
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
    extents.add(from: key(startOf: node), to: key(endOf: node), owner: owner, step: step)
    return step
  }

  /// One step with what its head holds below its own level, and then the steps of its block.
  private mutating func branch(
    _ kind: String, _ node: some SyntaxProtocol, _ text: String, head: Syntax? = nil, body: CodeBlockItemListSyntax? = nil, owner: Int, graph: inout Graph
  ) -> Step {
    let step = made(kind, node, text, owner: owner)
    if let head { step.children = inner(head, of: step, owner: owner, graph: &graph) }
    if let body { step.children += steps(body, owner: owner, graph: &graph) }
    return step
  }

  /// The steps of one statement. A branch gives one step for each of its arms.
  private mutating func steps(of node: Syntax, owner: Int, graph: inout Graph) -> [Step] {
    if let s = node.as(ExpressionStmtSyntax.self) { return steps(of: Syntax(s.expression), owner: owner, graph: &graph) }
    if let s = node.as(LabeledStmtSyntax.self) { return steps(of: Syntax(s.statement), owner: owner, graph: &graph) }
    if let s = node.as(IfExprSyntax.self) { return ifSteps(s, first: true, owner: owner, graph: &graph) }
    if let s = node.as(DoStmtSyntax.self) { return doSteps(s, owner: owner, graph: &graph) }
    if let s = node.as(IfConfigDeclSyntax.self) { return configSteps(s, owner: owner, graph: &graph) }
    if let s = node.as(SwitchExprSyntax.self) { return [switchStep(s, owner: owner, graph: &graph)] }
    if let s = node.as(RepeatStmtSyntax.self) { return [repeatStep(s, owner: owner, graph: &graph)] }
    if let s = node.as(GuardStmtSyntax.self) {
      return [branch("guard", s, text(s.conditions), head: Syntax(s.conditions), body: s.body.statements, owner: owner, graph: &graph)]
    }
    if let s = node.as(WhileStmtSyntax.self) {
      return [branch("while", s, text(s.conditions), head: Syntax(s.conditions), body: s.body.statements, owner: owner, graph: &graph)]
    }
    if let s = node.as(ForStmtSyntax.self) {
      let header = text(s.pattern) + " in " + text(s.sequence) + (s.whereClause.map { " " + text($0) } ?? "")
      return [branch("for", s, header, head: Syntax(s.sequence), body: s.body.statements, owner: owner, graph: &graph)]
    }
    if let s = node.as(DeferStmtSyntax.self) { return [branch("defer", s, "", body: s.body.statements, owner: owner, graph: &graph)] }
    if let s = node.as(ReturnStmtSyntax.self) {
      return [branch("return", s, text(s.expression), head: s.expression.map { Syntax($0) }, owner: owner, graph: &graph)]
    }
    if let s = node.as(ThrowStmtSyntax.self) { return [branch("throw", s, text(s.expression), head: Syntax(s.expression), owner: owner, graph: &graph)] }
    // A function inside a function is no symbol of the index: its body is part of the outline that holds it.
    if let s = node.as(FunctionDeclSyntax.self) { return [branch("func", s, s.name.text, body: s.body?.statements, owner: owner, graph: &graph)] }
    // A type inside a function is read as a declaration of the file.
    if SwiftBodyReader.typeDeclarations.contains(where: { node.is($0) }) { return [] }
    return [branch("stmt", node, text(node), head: node, owner: owner, graph: &graph)]
  }

  private static let typeDeclarations: [any SyntaxProtocol.Type] = [
    StructDeclSyntax.self, ClassDeclSyntax.self, EnumDeclSyntax.self, ActorDeclSyntax.self, ExtensionDeclSyntax.self, ProtocolDeclSyntax.self,
    TypeAliasDeclSyntax.self,
  ]

  private mutating func switchStep(_ s: SwitchExprSyntax, owner: Int, graph: inout Graph) -> Step {
    let step = branch("switch", s, text(s.subject), head: Syntax(s.subject), owner: owner, graph: &graph)
    for element in s.cases {
      guard case .switchCase(let c) = element else { continue }
      let isDefault = c.label.is(SwitchDefaultLabelSyntax.self)
      let label = isDefault ? "" : text(c.label).replacingOccurrences(of: #"^case |:$"#, with: "", options: .regularExpression)
      step.children.append(branch(isDefault ? "default" : "case", c, label, body: c.statements, owner: owner, graph: &graph))
    }
    return step
  }

  /// The condition of a `repeat` runs after its block, so what it holds comes last.
  private mutating func repeatStep(_ s: RepeatStmtSyntax, owner: Int, graph: inout Graph) -> Step {
    let step = branch("repeat", s, "while " + text(s.condition), body: s.body.statements, owner: owner, graph: &graph)
    step.children += inner(Syntax(s.condition), of: step, owner: owner, graph: &graph)
    return step
  }

  private mutating func doSteps(_ s: DoStmtSyntax, owner: Int, graph: inout Graph) -> [Step] {
    var out = [branch("do", s.body, "", body: s.body.statements, owner: owner, graph: &graph)]
    for clause in s.catchClauses {
      out.append(branch("catch", clause, text(clause.catchItems), body: clause.body.statements, owner: owner, graph: &graph))
    }
    return out
  }

  private mutating func configSteps(_ s: IfConfigDeclSyntax, owner: Int, graph: inout Graph) -> [Step] {
    var out: [Step] = []
    for clause in s.clauses {
      guard case .statements(let list)? = clause.elements else { continue }
      out.append(branch("#if", clause, clause.condition.map { text($0) } ?? "else", body: list, owner: owner, graph: &graph))
    }
    return out
  }

  private mutating func ifSteps(_ s: IfExprSyntax, first: Bool, owner: Int, graph: inout Graph) -> [Step] {
    let step = branch(first ? "if" : "else if", s, text(s.conditions), head: Syntax(s.conditions), body: s.body.statements, owner: owner, graph: &graph)
    switch s.elseBody {
    case .ifExpr(let next)?:
      return [step] + ifSteps(next, first: false, owner: owner, graph: &graph)
    case .codeBlock(let block)?:
      return [step, branch("else", block, "", body: block.statements, owner: owner, graph: &graph)]
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
      guard let name = SwiftBodyReader.calledName(call.calledExpression), let target = calls[key(startOf: name)],
        graph.takesHandOff(target), rules.allows(module: graph.nodes[target].module, name: graph.nodes[target].name)
      else { continue }
      let label = SwiftBodyReader.label(of: call, name: name.text)
      // A closure with an argument label is named with it, which tells two closures of one call apart.
      for argument in call.arguments {
        guard let closure = argument.expression.as(ClosureExprSyntax.self) else { continue }
        handed[closure.id] = argument.label.map { SwiftBodyReader.label(of: call, name: name.text, closure: $0.text) } ?? label
      }
      if let trailing = call.trailingClosure { handed[trailing.id] = label }
      for more in call.additionalTrailingClosures { handed[more.closure.id] = SwiftBodyReader.label(of: call, name: name.text, closure: more.label.text) }
      // A function that is passed by its name is an entry point too.
      for argument in call.arguments {
        guard let name = SwiftBodyReader.calledName(argument.expression), let passed = functionRefs[key(startOf: name)], !graph.nodes[passed].external else { continue }
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
          extents.add(from: key(startOf: closure), to: key(endOf: closure), owner: id, step: nil)
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
      return Step.firstLine(of: e.trimmedDescription, limit: 40)
    }
    if let closure { literals.append(closure + ":") }
    return name + "(" + literals.joined(separator: ", ") + ")"
  }
}

/// The hash of the tokens of a node, with no comment and no white space. The statements of a block inside are left out, because they are steps of their own.
private final class TokenText: SyntaxVisitor {
  var hash = TokenHash()
  override func visit(_ node: CodeBlockItemListSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
  override func visit(_ token: TokenSyntax) -> SyntaxVisitorContinueKind {
    hash.add(token.text.utf8)
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
