import Foundation

/// The public installation identity served at `GET /api/v1/system/identity`
/// (`InstallationIdentity` in `docs/openapi/core.yaml`).
///
/// This is the one hand-written API model in the app. It is the
/// version-independent bootstrap document every Tilecast client reads before
/// it knows anything else about a server, so it must decode without a
/// generated client. Ordinary endpoints use the generated OpenAPI client.
public struct InstallationIdentity: Equatable, Sendable {
    public let installationID: UUID
    public let organizationName: String
    public let apiVersion: String

    public init(installationID: UUID, organizationName: String, apiVersion: String = "v1") {
        self.installationID = installationID
        self.organizationName = organizationName
        self.apiVersion = apiVersion
    }
}

public enum InstallationIdentityError: Error, Equatable, Sendable {
    /// The request could not complete: offline, DNS, refused, or timed out.
    case unreachable
    /// TLS failed, for example an untrusted or expired certificate. The app
    /// never offers to bypass certificate validation.
    case untrustedCertificate
    /// The address answered, but not with a Tilecast identity document.
    case notTilecast
    /// A Tilecast server with an API major version this app does not know.
    case unsupportedAPIVersion(String)
}

extension InstallationIdentity {
    static let maximumDocumentBytes = 16 * 1024

    /// Decodes the response body. Unknown fields are ignored so that the
    /// server can add identity fields without breaking installed apps.
    static func decode(_ data: Data) throws(InstallationIdentityError) -> InstallationIdentity {
        struct Envelope: Decodable {
            struct Payload: Decodable {
                let product: String
                let apiVersion: String
                let installationId: UUID
                let organizationName: String
            }
            let data: Payload
        }
        guard data.count <= maximumDocumentBytes,
              let payload = try? JSONDecoder().decode(Envelope.self, from: data).data,
              payload.product == "tilecast" else { throw .notTilecast }
        guard payload.apiVersion == "v1" else { throw .unsupportedAPIVersion(payload.apiVersion) }
        return InstallationIdentity(
            installationID: payload.installationId,
            organizationName: payload.organizationName.trimmingCharacters(in: .whitespacesAndNewlines),
            apiVersion: payload.apiVersion
        )
    }
}

/// Reads a server's installation identity.
public protocol InstallationIdentityFetching: Sendable {
    func identity(at address: ServerAddress) async throws(InstallationIdentityError) -> InstallationIdentity
}

/// Fetches the identity with an ephemeral session: no cookies, cache, or
/// credentials are shared with Studio's WebKit data store.
public struct InstallationIdentityClient: InstallationIdentityFetching {
    private let session: URLSession

    public init(session: URLSession = InstallationIdentityClient.makeSession()) {
        self.session = session
    }

    public static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 15
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }

    public func identity(at address: ServerAddress) async throws(InstallationIdentityError) -> InstallationIdentity {
        guard let url = address.url(forPath: "/api/v1/system/identity") else { throw .notTilecast }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Self.classify(error)
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              WebOrigin(http.url ?? url) == WebOrigin(address.url) else { throw .notTilecast }
        return try InstallationIdentity.decode(data)
    }

    static func classify(_ error: any Error) -> InstallationIdentityError {
        guard let urlError = error as? URLError else { return .unreachable }
        switch urlError.code {
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid,
             .serverCertificateHasUnknownRoot, .clientCertificateRejected, .clientCertificateRequired,
             .secureConnectionFailed:
            return .untrustedCertificate
        case .appTransportSecurityRequiresSecureConnection:
            return .notTilecast
        default:
            return .unreachable
        }
    }
}
