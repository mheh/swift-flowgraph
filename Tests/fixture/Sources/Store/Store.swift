public struct OldStore {
  public init() {}
  public func find(_ id: Int) async throws -> String? { id > 0 ? "user\(id)" : nil }
  public func put(_ name: String) async throws {}
}
