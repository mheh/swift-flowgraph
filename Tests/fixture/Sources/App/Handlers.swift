import Router
import Store

enum AppError: Error { case unauthorized, notFound, tooLong }

struct Handlers {
  let store = OldStore()

  func upload(_ req: Request) async throws -> String {
    guard let token = req.token else {
      throw AppError.unauthorized
    }
    guard let user = try await store.find(req.id) else {
      throw AppError.notFound
    }
    if token.count > 8 {
      try await audit(user)
    } else {
      do {
        try await store.put(
          user + "!")
      } catch {
        return "kept"
      }
    }
    let size = (try? await measure(user)) ?? 0
    switch size {
    case 0: return "empty"
    case 1...10: return user
    default: throw AppError.tooLong
    }
  }

  func audit(_ name: String) async throws {
    try await store.put("audit " + name)
  }

  func measure(_ name: String) async throws -> Int { name.count }
}
