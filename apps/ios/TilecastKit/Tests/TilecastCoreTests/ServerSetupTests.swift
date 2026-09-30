import Foundation
import Testing
@testable import TilecastCore

@MainActor
@Suite struct ServerSetupTests {
    let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
    let client = FakeIdentityClient()

    @Test func refusesAnInvalidAddressWithoutAnyRequest() async {
        let setup = ServerSetup(directory: directory, identityClient: client)
        setup.addressText = "http://signage.example.org"
        await setup.check()
        #expect(setup.problem == .address(.publicHTTP))
        #expect(setup.step == .enterAddress)
    }

    @Test func confirmsWhatAnsweredBeforeSaving() async throws {
        let setup = ServerSetup(directory: directory, identityClient: client)
        let found = identity("Riverside Library")
        client.answers["http://192.168.1.50:8080"] = .success(found)
        setup.addressText = " http://192.168.1.50:8080/ "
        await setup.check()

        #expect(setup.step == .confirm(address("http://192.168.1.50:8080"), found))
        #expect(setup.displayName == "Riverside Library")
        #expect(directory.servers.isEmpty, "nothing is stored before confirmation")

        setup.displayName = "Branch Library"
        let profile = try #require(setup.add())
        #expect(profile.displayName == "Branch Library")
        #expect(profile.installationID == found.installationID)
        #expect(directory.servers == [profile])
    }

    @Test func reportsServersThatAreNotTilecast() async {
        let setup = ServerSetup(directory: directory, identityClient: client)
        client.answers["https://router.example.org"] = .failure(.notTilecast)
        setup.addressText = "router.example.org"
        await setup.check()
        #expect(setup.problem == .identity(.notTilecast, address("router.example.org")))
        #expect(setup.step == .enterAddress)
    }

    @Test func pointsAtTheExistingProfileForADuplicateInstallation() async throws {
        let found = identity("District")
        let existing = try directory.add(address: address("signage.example.org"), identity: found)
        client.answers["http://10.0.0.8"] = .success(found)
        let setup = ServerSetup(directory: directory, identityClient: client)
        setup.addressText = "http://10.0.0.8"
        await setup.check()
        #expect(setup.problem == .alreadyAdded(existing))
    }

    @Test func editingDiscardsALateAnswer() async {
        let setup = ServerSetup(directory: directory, identityClient: client)
        client.answers["https://slow.example.org"] = .success(identity("Slow"))
        client.gate("https://slow.example.org")
        setup.addressText = "slow.example.org"
        let checking = Task { await setup.check() }
        for await key in client.suspended where key == "https://slow.example.org" { break }
        #expect(setup.step == .checking)
        setup.edit()
        client.release("https://slow.example.org")
        await checking.value
        #expect(setup.step == .enterAddress)
        #expect(setup.problem == nil)
    }
}
