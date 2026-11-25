// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "flowgraph",
  platforms: [.macOS(.v14)],
  dependencies: [
    // Pinned, because indexstore-db has no release tags.
    .package(url: "https://github.com/swiftlang/indexstore-db", revision: "4ac2d61669d869071ddb582a5821c345c32103cd"),
    // Parses the bodies of the functions. The index says what a body uses, and the syntax says in which branch.
    .package(url: "https://github.com/swiftlang/swift-syntax", "600.0.0"..<"700.0.0"),
  ],
  targets: [
    .executableTarget(
      name: "flowgraph",
      dependencies: [
        .product(name: "IndexStore", package: "indexstore-db"),
        .product(name: "SwiftSyntax", package: "swift-syntax"),
        .product(name: "SwiftParser", package: "swift-syntax"),
      ],
      resources: [.copy("web")]
    )
  ]
)
