// swift-tools-version:5.9
import PackageDescription
let package = Package(name: "fixture", platforms: [.macOS(.v13)], targets: [
  .target(name: "Router"), .target(name: "Store"),
  .executableTarget(name: "App", dependencies: ["Router", "Store"]),
])
