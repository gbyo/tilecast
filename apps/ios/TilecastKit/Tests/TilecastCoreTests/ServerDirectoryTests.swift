import Foundation
import Testing
@testable import TilecastCore

func address(_ string: String) -> ServerAddress {
    try! ServerAddressPolicy.normalize(string).get()
}

func identity(_ name: String, id: UUID = UUID()) -> InstallationIdentity {
    InstallationIdentity(installationID: id, organizationName: name)
}

@MainActor
@Suite struct ServerDirectoryTests {
    @Test func addsServersWithIsolatedDataStores() throws {
        let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
        let a = try directory.add(address: address("a.example.org"), identity: identity("District A"))
        let b = try directory.add(address: address("http://192.168.1.20:8080"), identity: identity("Library"),
                                  displayName: "  Front Desk  ")
        #expect(a.displayName == "District A")
        #expect(b.displayName == "Front Desk")
        #expect(a.id != b.id)
        #expect(a.websiteDataStoreID != b.websiteDataStoreID)
        #expect(a.websiteDataStoreID != a.id)
        #expect(directory.activeServerID == nil)
    }

    @Test func refusesTheSameInstallationTwice() throws {
        let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
        let installation = UUID()
        let first = try directory.add(address: address("signage.example.org"), identity: identity("A", id: installation))
        #expect(throws: ServerDirectoryError.alreadyAdded(first)) {
            try directory.add(address: address("http://10.0.0.5"), identity: identity("A", id: installation))
        }
    }

    @Test func fallsBackToHostWhenNoNameIsAvailable() throws {
        let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
        let profile = try directory.add(address: address("signage.example.org"), identity: identity("   "))
        #expect(profile.displayName == "signage.example.org")
        directory.rename(profile.id, to: "")
        #expect(directory.server(withID: profile.id)?.displayName == "signage.example.org")
        directory.rename(profile.id, to: "Lobby")
        #expect(directory.server(withID: profile.id)?.displayName == "Lobby")
    }

    @Test func persistsAndRestoresTheDirectory() throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "tilecast-\(UUID()).json")
        defer { try? FileManager.default.removeItem(at: file) }
        let storage = FileServerDirectoryStorage(fileURL: file)
        let directory = ServerDirectory(storage: storage)
        // Stored dates have whole-second precision.
        let profile = try directory.add(address: address("signage.example.org"), identity: identity("A"),
                                        now: Date(timeIntervalSince1970: 1_800_000_000))
        directory.activate(profile.id, now: Date(timeIntervalSince1970: 1_800_000_060))
        directory.recordStudioPath("/screens?status=offline", for: profile.id)

        let restored = ServerDirectory(storage: storage)
        #expect(restored.servers == directory.servers)
        #expect(restored.activeServerID == profile.id)
        #expect(restored.activeServer?.lastStudioPath == "/screens?status=offline")
        #expect(restored.activeServer?.lastOpenedAt != nil)
    }

    @Test func ignoresSnapshotsFromANewerAppVersion() throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "tilecast-\(UUID()).json")
        defer { try? FileManager.default.removeItem(at: file) }
        try Data(#"{"version": 99, "servers": []}"#.utf8).write(to: file)
        #expect(try FileServerDirectoryStorage(fileURL: file).load() == nil)
    }

    @Test func removingTheActiveServerSelectsTheMostRecentOne() throws {
        let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
        let a = try directory.add(address: address("a.example.org"), identity: identity("A"))
        let b = try directory.add(address: address("b.example.org"), identity: identity("B"))
        let c = try directory.add(address: address("c.example.org"), identity: identity("C"))
        directory.activate(b.id, now: Date(timeIntervalSince1970: 100))
        directory.activate(a.id, now: Date(timeIntervalSince1970: 50))
        directory.activate(c.id, now: Date(timeIntervalSince1970: 200))

        #expect(directory.remove(c.id)?.id == c.id)
        #expect(directory.activeServerID == b.id)
        directory.remove(a.id)
        #expect(directory.activeServerID == b.id)
        directory.remove(b.id)
        #expect(directory.activeServerID == nil)
        #expect(directory.remove(b.id) == nil)
    }

    @Test func rebindingRotatesTheDataStore() throws {
        let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
        let profile = try directory.add(address: address("a.example.org"), identity: identity("Old"))
        directory.recordStudioPath("/media", for: profile.id)
        let replacement = identity("New")

        let oldStore = try directory.rebind(profile.id, to: replacement)
        let rebound = try #require(directory.server(withID: profile.id))
        #expect(oldStore == profile.websiteDataStoreID)
        #expect(rebound.websiteDataStoreID != profile.websiteDataStoreID)
        #expect(rebound.installationID == replacement.installationID)
        #expect(rebound.organizationName == "New")
        #expect(rebound.lastStudioPath == nil)
    }

    @Test func activeSelectionMustReferenceAKnownServer() throws {
        let storage = InMemoryServerDirectoryStorage()
        let directory = ServerDirectory(storage: storage)
        let profile = try directory.add(address: address("a.example.org"), identity: identity("A"))
        try storage.save(ServerDirectorySnapshot(servers: directory.servers, activeServerID: UUID()))
        #expect(ServerDirectory(storage: storage).activeServerID == profile.id)
    }
}
