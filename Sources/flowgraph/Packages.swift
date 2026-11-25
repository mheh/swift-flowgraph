import Foundation

/// One package: the project, or one checkout of a dependency.
struct PackageInfo {
  var name: String
  /// The path from the project, with a slash at the end. It is empty for the project.
  var prefix: String
  var products: [(name: String, type: String)] = []
  /// The modules that each product names.
  var productTargets: [String: [String]] = [:]
  /// The modules and the products that each module needs.
  var needs: [String: (targets: [String], products: [String])] = [:]
}

/// The names of the targets of the packages. A target of a package is a module, and never a binary of a build with no packages.
func targetNames(of packages: [PackageInfo]) -> Set<String> {
  Set(packages.flatMap { $0.needs.keys })
}

/// A build with no packages has binaries in place of products: a binary holds its own files and the headers that it reads.
/// Adds each module that is named after a binary to `memberships`, and gives the names of the binaries, in order.
func addBinaries(_ binaries: [String: Set<String>], to memberships: inout [String: [String]], targets: Set<String>) -> [String] {
  let packaged = memberships
  var names = Set<String>()
  for (module, readers) in binaries where packaged[module] == nil && !targets.contains(module) {
    var found = Set<String>()
    for reader in readers {
      // A target of a package is in the products of the package already, or in none of them.
      if let known = packaged[reader] {
        found.formUnion(known)
      } else if !targets.contains(reader) {
        found.insert(reader)
        names.insert(reader)
      }
    }
    memberships[module] = found.sorted()
  }
  return names.sorted()
}

/// The products that each module is linked into: a product holds the targets that it names and all that they need,
/// in its own package and in the packages of its dependencies.
func memberships(of packages: [PackageInfo]) -> [String: [String]] {
  var targetsOfProduct: [String: [String]] = [:]
  var needs: [String: (targets: [String], products: [String])] = [:]
  for p in packages {
    targetsOfProduct.merge(p.productTargets) { old, _ in old }
    needs.merge(p.needs) { old, _ in old }
  }
  var result: [String: [String]] = [:]
  for p in packages {
    for product in p.products {
      var seen = Set<String>()
      var queue = targetsOfProduct[product.name] ?? []
      while let module = queue.popLast() {
        guard seen.insert(module).inserted else { continue }
        result[module, default: []].append(product.name)
        queue += needs[module]?.targets ?? []
        for dependency in needs[module]?.products ?? [] { queue += targetsOfProduct[dependency] ?? [] }
      }
    }
  }
  return result
}

/// What `swift package describe` says about the package at one path, or nil when the path holds no package.
func describePackage(at path: String, prefix: String) -> PackageInfo? {
  guard FileManager.default.fileExists(atPath: path + "/Package.swift"),
    let text = runSwift(["package", "--package-path", path, "describe", "--type", "json"]),
    let start = text.firstIndex(of: "{"),
    let top = try? JSONSerialization.jsonObject(with: Data(text[start...].utf8)) as? [String: Any]
  else { return nil }
  var info = PackageInfo(name: top["name"] as? String ?? URL(fileURLWithPath: path).lastPathComponent, prefix: prefix)
  // A product and a dependency name a target, and the index names its module.
  var c99: [String: String] = [:]
  for t in top["targets"] as? [[String: Any]] ?? [] {
    if let name = t["name"] as? String { c99[name] = t["c99name"] as? String ?? name }
  }
  for p in top["products"] as? [[String: Any]] ?? [] {
    guard let name = p["name"] as? String else { continue }
    info.products.append((name, (p["type"] as? [String: Any])?.keys.first ?? ""))
    info.productTargets[name] = (p["targets"] as? [String] ?? []).map { c99[$0] ?? $0 }
  }
  for t in top["targets"] as? [[String: Any]] ?? [] {
    guard let module = t["c99name"] as? String ?? t["name"] as? String else { continue }
    info.needs[module] = ((t["target_dependencies"] as? [String] ?? []).map { c99[$0] ?? $0 }, t["product_dependencies"] as? [String] ?? [])
  }
  return info
}

/// The project and, when asked for, each checkout of a dependency under .build/checkouts.
func readPackages(project: String, withCheckouts: Bool) -> (packages: [PackageInfo], checkoutDirectories: [String]) {
  var packages: [PackageInfo] = []
  if let own = describePackage(at: project, prefix: "") { packages.append(own) }
  let root = project + "/.build/checkouts"
  let names = withCheckouts ? ((try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []).sorted() : []
  for dir in names {
    let prefix = ".build/checkouts/\(dir)/"
    packages.append(describePackage(at: root + "/" + dir, prefix: prefix) ?? PackageInfo(name: dir, prefix: prefix))
  }
  return (packages, names.map { root + "/" + $0 })
}
