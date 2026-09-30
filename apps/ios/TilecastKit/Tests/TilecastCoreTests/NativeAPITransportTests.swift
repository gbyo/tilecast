import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession
import Testing
import TilecastAPI
@testable import TilecastCore

/// Answers requests from a script and records exactly what URLSession sent,
/// headers included, so tests see the wire and not the client's intent.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    struct Answer: Sendable {
        var status: Int
        var headers: [String: String] = ["Content-Type": "application/json"]
        var body: String = ""
    }

    struct Seen: Sendable {
        let method: String
        let url: URL
        let headers: [String: String]
        let body: Data?
    }

    nonisolated(unsafe) private static var answers: [String: [Answer]] = [:]
    nonisolated(unsafe) private static var seen: [Seen] = []
    private static let lock = NSLock()

    /// Queues answers for a path; the last one repeats.
    static func answer(_ path: String, _ answers: Answer...) {
        lock.withLock { self.answers[path, default: []].append(contentsOf: answers) }
    }

    static var requests: [Seen] { lock.withLock { seen } }

    static func reset() {
        lock.withLock {
            answers = [:]
            seen = []
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
            body = data
        }
        let answer = Self.lock.withLock { () -> Answer? in
            Self.seen.append(Seen(method: request.httpMethod ?? "GET", url: url, headers: request.allHTTPHeaderFields ?? [:], body: body))
            guard var queue = Self.answers[url.path], let first = queue.first else { return nil }
            if queue.count > 1 { queue.removeFirst() }
            Self.answers[url.path] = queue
            return first
        } ?? Answer(status: 404, body: #"{"error":{"code":"not_found","message":"no"}}"#)
        let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: answer.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

func stubTransport() -> any ClientTransport {
    // Buffered, not the platform streaming default: with
    // uploadTask(withStreamedRequest:) the request body reaches a
    // URLProtocol asynchronously, so StubProtocol's synchronous read races
    // the writer and usually sees nothing on a loaded runner.
    URLSessionTransport(configuration: .init(
        session: NativeAPITransport.makeSession(protocolClasses: [StubProtocol.self]),
        httpBodyProcessingMode: .buffered
    ))
}

let grantsBody = #"{"data":{"grants":[{"id":"8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e","client":"Tilecast for iOS","scopes":["read","write","admin"],"createdAt":"2026-09-29T21:30:00.123456789Z","lastUsedAt":null,"revokedAt":null}]}}"#

/// URLProtocol stubs are process-wide, so every suite that uses them runs
/// inside this one, one test at a time.
@Suite(.serialized) struct StubbedHTTPTests {}

extension StubbedHTTPTests {
    @Suite struct NativeAPITransportTests {
        let server = FakeSessionServer()
        let store = InMemoryCredentialStore()

        init() { StubProtocol.reset() }

        func signedInSession() async throws -> NativeAuthSession {
            let session = NativeAuthSession(
                key: NativeCredentialKey(serverID: UUID(), installationID: UUID()),
                address: address("signage.example.org"), exchanger: server, store: store
            )
            _ = try await session.completeSignIn(code: "code", verifier: "verifier")
            return session
        }

        @Test func authenticatesWithTheBearerTokenAndNoCookie() async throws {
            // A cookie any shared store would offer this host must not be sent.
            HTTPCookieStorage.shared.setCookie(studioCookie(host: "signage.example.org", value: "leaked"))
            defer { HTTPCookieStorage.shared.cookies?.forEach(HTTPCookieStorage.shared.deleteCookie) }
            StubProtocol.answer("/api/v1/me/security/grants", .init(status: 200, body: grantsBody))
            let client = try await signedInSession().makeClient(transport: stubTransport())

            let grants = try await client.listOAuthGrants().ok.body.json.data.grants
            #expect(grants.map(\.client) == ["Tilecast for iOS"])

            let request = try #require(StubProtocol.requests.last)
            #expect(request.url.absoluteString == "https://signage.example.org/api/v1/me/security/grants")
            #expect(request.headers["Authorization"] == "Bearer tca_access1")
            #expect(request.headers.keys.contains { $0.caseInsensitiveCompare("Cookie") == .orderedSame } == false)
        }

        @Test func retriesOnceWithARotatedTokenAfter401() async throws {
            StubProtocol.answer(
                "/api/v1/me/security/grants",
                .init(status: 401, body: #"{"error":{"code":"authentication_required","message":"no"}}"#),
                .init(status: 200, body: grantsBody)
            )
            let session = try await signedInSession()
            _ = try await session.makeClient(transport: stubTransport()).listOAuthGrants().ok
            #expect(StubProtocol.requests.map { $0.headers["Authorization"] } == ["Bearer tca_access1", "Bearer tca_access2"])
            #expect(server.refreshCalls.count == 1)
        }

        @Test func aRevokedGrantEndsInUnauthenticatedNotALoop() async throws {
            StubProtocol.answer("/api/v1/me/security/grants", .init(status: 401, body: #"{"error":{"code":"authentication_required","message":"no"}}"#))
            let session = try await signedInSession()
            server.revokeGrant()
            await #expect {
                try await session.makeClient(transport: stubTransport()).listOAuthGrants()
            } throws: { error in
                (error as? ClientError)?.underlyingError as? NativeAuthError == .unauthenticated
            }
            #expect(StubProtocol.requests.count == 1)
            #expect(server.refreshCalls.count == 1)
            #expect(try store.storedKeys().isEmpty)
        }

        @Test func sendsNothingWithoutACredential() async throws {
            let session = NativeAuthSession(
                key: NativeCredentialKey(serverID: UUID(), installationID: UUID()),
                address: address("signage.example.org"), exchanger: server, store: store
            )
            await #expect(throws: ClientError.self) {
                try await session.makeClient(transport: stubTransport()).listOAuthGrants()
            }
            #expect(StubProtocol.requests.isEmpty)
        }
    }

    @Suite struct IOSSessionClientTests {
        let address = TilecastCoreTests.address("signage.example.org")

        init() { StubProtocol.reset() }

        var client: IOSSessionClient { IOSSessionClient(address: address, transport: stubTransport()) }

        static let cookieHeader = "tilecast_session=opaque; Path=/; HttpOnly; SameSite=Lax"
        static let credentialBody = #"{"data":{"authenticated":true,"credential":{"access_token":"tca_a","refresh_token":"tcr_r","token_type":"Bearer","expires_at":"2026-09-29T21:45:00.123456789Z","scope":"added later"},"addedLater":true}}"#

        @Test func exchangesACodeForACookieAndACredential() async throws {
            StubProtocol.answer("/api/v1/oauth/ios-session", .init(
                status: 200, headers: ["Content-Type": "application/json", "Set-Cookie": Self.cookieHeader], body: Self.credentialBody
            ))
            let grant = try await client.exchange(code: "the-code", verifier: "the-verifier")
            #expect(grant.cookie?.value == "opaque")
            #expect(grant.cookie?.isHTTPOnly == true)
            #expect(grant.credential?.accessToken == "tca_a")
            #expect(grant.credential?.refreshToken == "tcr_r")
            let expiry = try #require(grant.credential?.expiresAt.timeIntervalSince1970)
            #expect(abs(expiry - 1_790_718_300.123) < 0.001, "nine fractional digits decode")

            let request = try #require(StubProtocol.requests.first)
            #expect(request.method == "POST")
            #expect(request.headers.keys.contains { ["cookie", "authorization"].contains($0.lowercased()) } == false)
            let body = try #require(try JSONSerialization.jsonObject(with: request.body ?? Data()) as? [String: String])
            #expect(body == [
                "grant_type": "authorization_code", "client_id": "tilecast-ios", "code": "the-code",
                "redirect_uri": "tilecast-ios://oauth/callback", "code_verifier": "the-verifier",
            ])
        }

        /// The response of a server released before native API access.
        @Test func acceptsACookieOnlyResponseFromAnOlderServer() async throws {
            StubProtocol.answer("/api/v1/oauth/ios-session", .init(
                status: 200, headers: ["Content-Type": "application/json", "Set-Cookie": Self.cookieHeader],
                body: #"{"data":{"authenticated":true}}"#
            ))
            let grant = try await client.exchange(code: "c", verifier: "v")
            #expect(grant.cookie?.value == "opaque")
            #expect(grant.credential == nil)
        }

        @Test func refusesACookieForAnotherHost() async throws {
            StubProtocol.answer("/api/v1/oauth/ios-session", .init(
                status: 200,
                headers: ["Content-Type": "application/json", "Set-Cookie": "tilecast_session=x; Domain=evil.example; Path=/; HttpOnly"],
                body: #"{"data":{"authenticated":true}}"#
            ))
            await #expect(throws: IOSSessionError.missingCookie) { try await client.exchange(code: "c", verifier: "v") }
        }

        @Test func refreshesWithoutAStudioSession() async throws {
            StubProtocol.answer("/api/v1/oauth/ios-session", .init(
                status: 200, body: #"{"data":{"authenticated":false,"credential":{"access_token":"tca_b","refresh_token":"tcr_b","token_type":"Bearer","expires_at":"2026-09-29T21:45:00Z"}}}"#
            ))
            let grant = try await client.refresh(refreshToken: "tcr_r", studioSession: false)
            #expect(grant.credential?.refreshToken == "tcr_b")
            #expect(grant.cookie == nil)
            let body = try #require(try JSONSerialization.jsonObject(with: StubProtocol.requests.first?.body ?? Data()) as? [String: Any])
            #expect(body["grant_type"] as? String == "refresh_token")
            #expect(body["refresh_token"] as? String == "tcr_r")
            #expect(body["studio_session"] as? Bool == false)
        }

        @Test(arguments: [
            (400, IOSSessionError.rejected),
            (401, IOSSessionError.rejected),
            (429, IOSSessionError.unavailable),
            (500, IOSSessionError.unavailable),
            (503, IOSSessionError.unavailable),
        ])
        func classifiesFailures(_ status: Int, _ expected: IOSSessionError) async throws {
            StubProtocol.answer("/api/v1/oauth/ios-session", .init(status: status, body: #"{"error":{"code":"invalid_grant","message":"no"}}"#))
            await #expect(throws: expected) { try await client.refresh(refreshToken: "tcr_r", studioSession: false) }
        }

        @Test func neverFollowsARedirect() async throws {
            StubProtocol.answer("/api/v1/oauth/ios-session", .init(
                status: 307, headers: ["Location": "https://evil.example/api/v1/oauth/ios-session"]
            ))
            await #expect(throws: IOSSessionError.unavailable) { try await client.exchange(code: "c", verifier: "v") }
            #expect(StubProtocol.requests.map(\.url.host) == ["signage.example.org"])
        }
    }
}
