public import Foundation
public import IndexStoreCAPI

/// The index reader that is linked into the program. It takes the place of the type that loads the reader from a library.
public struct IndexStoreLibrary: Sendable {
  @usableFromInline
  let api: indexstore_functions_t

  public static func at(dylibPath: URL) async throws -> IndexStoreLibrary {
    IndexStoreLibrary(api: indexstore_linked_functions())
  }

  public func indexStore(at path: URL) throws -> IndexStore {
    try IndexStore(at: path, library: self)
  }
}
