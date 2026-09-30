import Foundation
import WebKit

/// Creates and deletes the persistent WebKit data stores that isolate
/// servers. Each server has its own store, so cookies, cache, local storage,
/// IndexedDB, and service workers never cross between installations. Every
/// page for one server (the main Studio page and any auxiliary or, later,
/// presentation page) uses that server's store.
@MainActor
public protocol WebsiteDataStoreManaging: AnyObject {
    func dataStore(for identifier: UUID) -> WKWebsiteDataStore
    /// Deletes a store and everything in it. The caller must first release
    /// every page that uses the store; WebKit refuses to delete a store in use.
    func removeDataStore(for identifier: UUID) async throws
    func existingDataStoreIdentifiers() async -> [UUID]
}

@MainActor
public final class WebsiteDataStores: WebsiteDataStoreManaging {
    public init() {}

    public func dataStore(for identifier: UUID) -> WKWebsiteDataStore {
        WKWebsiteDataStore(forIdentifier: identifier)
    }

    public func removeDataStore(for identifier: UUID) async throws {
        // Clear the contents first. WebKit keeps a live store object's state
        // in memory, so deleting only the identifier can leave cookies behind
        // for as long as any object for it exists.
        await clearData(in: identifier)
        try await WKWebsiteDataStore.remove(forIdentifier: identifier)
    }

    private func clearData(in identifier: UUID) async {
        let store = WKWebsiteDataStore(forIdentifier: identifier)
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }

    public func existingDataStoreIdentifiers() async -> [UUID] {
        // Listing identifiers before any other WebKit object exists crashes
        // inside WebKit (its main run loop is not set up yet). Creating a
        // store on the main actor initializes WebKit first.
        _ = WKWebsiteDataStore.nonPersistent()
        return await WKWebsiteDataStore.allDataStoreIdentifiers
    }
}
