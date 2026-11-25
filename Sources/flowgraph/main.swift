import Foundation

func main() async throws {
  var options = try Options(Array(CommandLine.arguments.dropFirst()))
  if options.command == .snapshot, let ref = options.ref { try checkOut(ref, for: &options) }
  switch options.command {
  case .snapshot:
    let snapshot = try await makeSnapshot(options)
    if let out = options.out {
      try snapshot.write(to: URL(fileURLWithPath: out))
      print(out)
    }
    if let html = options.html {
      try Page().singleFile(snapshot: snapshot).write(toFile: html, atomically: true, encoding: .utf8)
      print(html)
    }
  case .page:
    let out = options.out ?? "flowgraph.html"
    let snapshot = try options.snapshot.map { try Data(contentsOf: URL(fileURLWithPath: $0)) }
    try Page().singleFile(snapshot: snapshot).write(toFile: out, atomically: true, encoding: .utf8)
    print(out)
  case .site:
    let out = options.out ?? "flowgraph-site"
    try Page().site(at: out, exporter: options.exporter)
    print(out)
  case .listEntries:
    let (packages, checkouts) = readPackages(project: options.project, withCheckouts: options.checkouts)
    let graph = try await readGraph(options, checkoutDirectories: checkouts, targets: targetNames(of: packages)).graph
    for n in graph.nodes where n.entry { print("\(n.module).\(n.name)\t\(graph.files[n.file]):\(n.line)\t\(n.label)") }
  case .listProducts:
    for p in readPackages(project: options.project, withCheckouts: true).packages {
      for product in p.products { print("\(p.name)\t\(product.name)\t\(product.type)") }
    }
  }
}

do {
  try await main()
} catch {
  log("flowgraph: \(error)")
  exit(1)
}
