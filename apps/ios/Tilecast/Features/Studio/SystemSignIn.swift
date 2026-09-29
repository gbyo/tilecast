import AuthenticationServices
import Foundation
import TilecastCore
import UIKit
import WebKit

/// Owns the system browser until its custom-scheme callback arrives.
@MainActor
final class SystemSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func cancel() { session?.cancel() }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) { return window }
        return UIWindow(windowScene: scenes[0])
    }

    func authenticate(page: StudioPage) async throws {
        let attempt = try IOSSignInRequest(server: page.address)
        let callback = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            let session = ASWebAuthenticationSession(
                url: attempt.authorizationURL,
                callbackURLScheme: "tilecast-ios"
            ) { [weak self] url, error in
                Task { @MainActor in
                    self?.session = nil
                    if let error { continuation.resume(throwing: error) }
                    else if let url { continuation.resume(returning: url) }
                    else { continuation.resume(throwing: IOSSignInError.invalidCallback) }
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.session = nil
                continuation.resume(throwing: IOSSignInError.serverRejected)
            }
        }
        let code = try attempt.code(from: callback)
        guard !page.isClosed else { throw IOSSignInError.invalidCallback }
        var request = URLRequest(url: page.address.url.appending(path: "/api/v1/oauth/ios-session"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "grant_type": "authorization_code",
            "client_id": IOSSignInRequest.clientID,
            "redirect_uri": IOSSignInRequest.redirectURI,
            "code": code,
            "code_verifier": attempt.verifier,
        ])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        let network = URLSession(configuration: configuration)
        defer { network.invalidateAndCancel() }
        let (_, response) = try await network.data(for: request)
        guard let response = response as? HTTPURLResponse,
              response.statusCode == 200,
              WebOrigin(response.url ?? request.url!) == page.address.origin else {
            throw IOSSignInError.serverRejected
        }
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, item in
            if let key = item.key as? String, let value = item.value as? String { result[key] = value }
        }
        guard let cookie = HTTPCookie.cookies(withResponseHeaderFields: headers, for: page.address.url)
            .first(where: { $0.isHTTPOnly && $0.domain == page.address.host }) else {
            throw IOSSignInError.missingCookie
        }
        guard !page.isClosed else { throw IOSSignInError.invalidCallback }
        await page.websiteDataStore.httpCookieStore.setCookie(cookie)
        guard !page.isClosed else { throw IOSSignInError.invalidCallback }
        page.resumeAfterSignIn()
    }
}
