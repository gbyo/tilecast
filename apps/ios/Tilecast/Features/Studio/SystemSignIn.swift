import AuthenticationServices
import Foundation
import TilecastCore
import UIKit

/// Owns the system browser until its custom-scheme callback arrives. The
/// server's own pages handle passwords, authenticator codes, recovery codes,
/// and passkeys; the app never sees them. What happens with the code is
/// `StudioHost.completeSignIn`'s job.
@MainActor
final class SystemSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func cancel() { session?.cancel() }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) { return window }
        return UIWindow(windowScene: scenes[0])
    }

    func authenticate(page: StudioPage, host: StudioHost) async throws {
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
        // State and issuer are checked before the code goes anywhere.
        let code = try attempt.code(from: callback)
        try await host.completeSignIn(code: code, verifier: attempt.verifier, for: page)
    }
}
