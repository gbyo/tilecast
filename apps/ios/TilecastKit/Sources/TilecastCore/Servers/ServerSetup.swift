import Foundation
import Observation

/// The add-server flow: normalize the typed address, read the server's
/// public installation identity, let the user confirm what answered, then
/// save the profile. Nothing is stored until the user confirms.
@MainActor
@Observable
public final class ServerSetup {
    public enum Step: Equatable {
        case enterAddress
        case checking
        case confirm(ServerAddress, InstallationIdentity)
    }

    public enum Problem: Equatable {
        case address(ServerAddressError)
        case identity(InstallationIdentityError, ServerAddress)
        case alreadyAdded(ServerProfile)
    }

    public var addressText = ""
    public var displayName = ""
    public private(set) var step: Step = .enterAddress
    public private(set) var problem: Problem?

    @ObservationIgnored private let identityClient: any InstallationIdentityFetching
    @ObservationIgnored private let directory: ServerDirectory
    /// Distinguishes checks so an answer for an abandoned one is dropped.
    @ObservationIgnored private var attempt = 0

    public init(directory: ServerDirectory, identityClient: any InstallationIdentityFetching) {
        self.directory = directory
        self.identityClient = identityClient
    }

    public var canCheck: Bool {
        step == .enterAddress && !addressText.trimmingCharacters(in: .whitespaces).isEmpty
    }

    public func check() async {
        guard step == .enterAddress else { return }
        problem = nil
        let address: ServerAddress
        switch ServerAddressPolicy.normalize(addressText) {
        case .failure(let error):
            problem = .address(error)
            return
        case .success(let normalized):
            address = normalized
        }
        step = .checking
        attempt += 1
        let current = attempt
        do {
            let identity = try await identityClient.identity(at: address)
            guard current == attempt else { return }
            if let existing = directory.servers.first(where: { $0.installationID == identity.installationID }) {
                problem = .alreadyAdded(existing)
                step = .enterAddress
                return
            }
            displayName = identity.organizationName
            step = .confirm(address, identity)
        } catch {
            guard current == attempt else { return }
            problem = .identity(error, address)
            step = .enterAddress
        }
    }

    /// Returns to address entry, discarding a pending check or confirmation.
    public func edit() {
        attempt += 1
        step = .enterAddress
    }

    /// Saves the confirmed server and returns it.
    public func add() -> ServerProfile? {
        guard case .confirm(let address, let identity) = step else { return nil }
        do {
            return try directory.add(address: address, identity: identity, displayName: displayName)
        } catch {
            if case .alreadyAdded(let existing) = error { problem = .alreadyAdded(existing) }
            step = .enterAddress
            return nil
        }
    }
}
