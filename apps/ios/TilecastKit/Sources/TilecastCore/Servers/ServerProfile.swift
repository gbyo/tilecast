import Foundation

/// How the app authenticates to one server.
///
/// Studio signs in with its own HttpOnly session cookie, which lives only in
/// this server's WebKit data store. The native OAuth credential that the same
/// sign-in produces is not recorded here: its refresh token lives in the
/// Keychain, keyed by this profile and its installation, and whether one
/// exists is read from the Keychain, never from this record.
public enum ServerAuthentication: String, Codable, Sendable {
    case studioSession
}

/// One configured Tilecast installation. The record holds no secrets and is
/// safe to persist as plain JSON.
public struct ServerProfile: Identifiable, Hashable, Codable, Sendable {
    /// Stable local identity. Never sent to the server.
    public let id: UUID
    public var displayName: String
    public var address: ServerAddress
    /// The installation this profile was bound to when it was added. The
    /// app refuses to load Studio if the address later serves a different
    /// installation, exactly as Players refuse to send a stored credential.
    public var installationID: UUID
    public var organizationName: String
    public var authentication: ServerAuthentication
    /// Identifier of the persistent `WKWebsiteDataStore` that holds this
    /// server's cookies, cache, and web storage. It is separate from `id`
    /// so a profile can discard its web data and start a fresh store.
    public var websiteDataStoreID: UUID
    /// Last same-origin Studio path, restored on the next launch.
    public var lastStudioPath: String?
    public let createdAt: Date
    public var lastOpenedAt: Date?
    /// When the user last signed out explicitly. While set, the app waits
    /// for the user to choose Sign In instead of opening the system sign-in
    /// sheet by itself. A completed sign-in clears it.
    public var signedOutAt: Date?

    public init(
        id: UUID = UUID(),
        displayName: String,
        address: ServerAddress,
        identity: InstallationIdentity,
        websiteDataStoreID: UUID = UUID(),
        createdAt: Date = .now
    ) {
        self.id = id
        self.displayName = displayName
        self.address = address
        self.installationID = identity.installationID
        self.organizationName = identity.organizationName
        self.authentication = .studioSession
        self.websiteDataStoreID = websiteDataStoreID
        self.lastStudioPath = nil
        self.createdAt = createdAt
        self.lastOpenedAt = nil
        self.signedOutAt = nil
    }
}
