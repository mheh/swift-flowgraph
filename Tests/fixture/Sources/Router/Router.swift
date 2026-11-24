public struct Request { public var id: Int; public var token: String?; public init(id: Int, token: String?) { self.id = id; self.token = token } }
public final class Router {
  public init() {}
  var handlers: [String: (Request) async throws -> String] = [:]
  public func get(_ path: String, use handler: @escaping (Request) async throws -> String) { handlers["GET " + path] = handler }
  public func post(_ path: String, use handler: @escaping (Request) async throws -> String) { handlers["POST " + path] = handler }
  public func run(_ key: String, _ r: Request) async throws -> String { try await handlers[key]!(r) }
}
