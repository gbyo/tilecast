import Foundation
@testable import TilecastCore

/// Suspends callers until opened.
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { continuation in
            let resume = lock.withLock { () -> Bool in
                if isOpen { return true }
                waiters.append(continuation)
                return false
            }
            if resume { continuation.resume() }
        }
    }

    func open() {
        let waiters = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            isOpen = true
            defer { self.waiters.removeAll() }
            return self.waiters
        }
        for waiter in waiters { waiter.resume() }
    }
}

func studioCookie(host: String, value: String = "studio-session") -> HTTPCookie {
    HTTPCookie(properties: [
        .domain: host, .path: "/", .name: "tilecast_session", .value: value,
        HTTPCookiePropertyKey("HttpOnly"): "TRUE",
    ])!
}

/// A Tilecast server's iOS session endpoint with its real refresh-token
/// rules: every rotation retires the presented token, and presenting a
/// retired token revokes the whole grant, exactly as reuse detection does.
final class FakeSessionServer: IOSSessionExchanging, @unchecked Sendable {
    struct RefreshCall: Equatable {
        let token: String
        let studioSession: Bool
    }

    private let lock = NSLock()
    let host: String
    private var issued = 0
    private var current: String?
    private var _revoked = false
    private var _refreshCalls: [RefreshCall] = []
    private var _revokedTokens: [String] = []
    private var _inFlight = 0
    private var _maximumInFlight = 0
    private var _nextFailure: IOSSessionError?
    /// Answers a sign-in without a credential, as a server released before
    /// native API access does.
    var issuesCredentials = true
    /// Holds each refresh until opened.
    var refreshGate: Gate?
    /// The access-token lifetime this server grants.
    var lifetime: TimeInterval = 900
    var now: @Sendable () -> Date = { .now }

    init(host: String = "signage.example.org") {
        self.host = host
    }

    var refreshCalls: [RefreshCall] { lock.withLock { _refreshCalls } }
    var revokedTokens: [String] { lock.withLock { _revokedTokens } }
    var maximumInFlight: Int { lock.withLock { _maximumInFlight } }
    var grantRevoked: Bool { lock.withLock { _revoked } }
    var currentRefreshToken: String? { lock.withLock { current } }

    /// The next refresh fails with `failure` without touching the grant.
    func failNextRefresh(with failure: IOSSessionError) {
        lock.withLock { _nextFailure = failure }
    }

    /// Account security revokes the grant.
    func revokeGrant() {
        lock.withLock { _revoked = true }
    }

    private func issue() -> NativeCredential {
        issued += 1
        let credential = NativeCredential(
            accessToken: "tca_access\(issued)", refreshToken: "tcr_refresh\(issued)",
            expiresAt: now().addingTimeInterval(lifetime)
        )
        current = credential.refreshToken
        return credential
    }

    func exchange(code: String, verifier: String) async throws(IOSSessionError) -> IOSSessionGrant {
        lock.withLock {
            let credential = issuesCredentials ? issue() : nil
            return IOSSessionGrant(cookie: studioCookie(host: host), credential: credential)
        }
    }

    func refresh(refreshToken: String, studioSession: Bool) async throws(IOSSessionError) -> IOSSessionGrant {
        lock.withLock {
            _refreshCalls.append(.init(token: refreshToken, studioSession: studioSession))
            _inFlight += 1
            _maximumInFlight = max(_maximumInFlight, _inFlight)
        }
        if let refreshGate { await refreshGate.wait() }
        let result = lock.withLock { () -> Result<IOSSessionGrant, IOSSessionError> in
            defer { _inFlight -= 1 }
            if let failure = _nextFailure {
                _nextFailure = nil
                return .failure(failure)
            }
            guard !_revoked, refreshToken == current else {
                // A retired token: reuse detection revokes the grant.
                _revoked = true
                return .failure(.rejected)
            }
            return .success(IOSSessionGrant(cookie: studioSession ? studioCookie(host: host, value: "renewed") : nil, credential: issue()))
        }
        return try result.get()
    }

    func revoke(token: String) async {
        lock.withLock {
            _revokedTokens.append(token)
            _revoked = true
        }
    }
}

/// A mutable clock for expiry tests.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date { lock.withLock { current } }
    func advance(_ interval: TimeInterval) { lock.withLock { current = current.addingTimeInterval(interval) } }
}
