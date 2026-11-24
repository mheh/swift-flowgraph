import Router

let router = Router()
let handlers = Handlers()
router.post("upload", use: handlers.upload)
router.get("health") { _ in
  let names = ["a", "b"].map { $0 + "!" }
  return names.joined()
}
router.get("users") { req in
  guard req.id > 0 else { throw AppError.notFound }
  return try await handlers.upload(req)
}
print(try await router.run("GET health", Request(id: 1, token: nil)))
