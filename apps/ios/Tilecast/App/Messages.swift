import Foundation
import TilecastCore

// User-visible text for Core's error values. Core carries no strings.

extension ServerAddressError {
    var message: String {
        switch self {
        case .empty:
            String(localized: "Enter your Tilecast server address.")
        case .unsupportedScheme:
            String(localized: "Use an address that starts with https:// or, on a local network, http://.")
        case .invalid:
            String(localized: "That doesn’t look like a server address. Enter a host name such as signage.example.org.")
        case .containsPath:
            String(localized: "Enter only the server address, without a path such as /login.")
        case .publicHTTP:
            String(localized: "Servers on the internet must use HTTPS. Plain HTTP works only for local network addresses such as 192.168.1.20 or tilecast.local.")
        }
    }
}

extension InstallationIdentityError {
    var title: String {
        switch self {
        case .unreachable: String(localized: "Can’t Reach Server")
        case .untrustedCertificate: String(localized: "Certificate Not Trusted")
        case .notTilecast: String(localized: "Not a Tilecast Server")
        case .unsupportedAPIVersion: String(localized: "Server Version Not Supported")
        }
    }

    var systemImage: String {
        switch self {
        case .unreachable: "wifi.exclamationmark"
        case .untrustedCertificate: "lock.trianglebadge.exclamationmark"
        case .notTilecast: "questionmark.app.dashed"
        case .unsupportedAPIVersion: "arrow.up.circle"
        }
    }

    func message(for address: ServerAddress) -> String {
        switch self {
        case .unreachable where address.isLocalNetwork:
            String(localized: "Check that you’re on the same network as the server and that Local Network access for Tilecast is on in Settings.")
        case .unreachable:
            String(localized: "Check your internet connection and that the server is running.")
        case .untrustedCertificate:
            String(localized: "The server’s certificate isn’t valid or isn’t trusted by this device. Tilecast only connects to servers with a trusted certificate.")
        case .notTilecast:
            String(localized: "Something answered at this address, but it isn’t a Tilecast server. Check the address you use for Tilecast Studio.")
        case .unsupportedAPIVersion:
            String(localized: "This server uses a newer Tilecast version than this app supports. Update the app to connect.")
        }
    }
}

extension StudioLoadFailure {
    var title: String {
        switch self {
        case .unreachable: String(localized: "Can’t Reach Server")
        case .untrustedCertificate: String(localized: "Certificate Not Trusted")
        case .contentProcessEnded, .other: String(localized: "Studio Couldn’t Load")
        }
    }

    var systemImage: String {
        switch self {
        case .unreachable: "wifi.exclamationmark"
        case .untrustedCertificate: "lock.trianglebadge.exclamationmark"
        case .contentProcessEnded, .other: "exclamationmark.triangle"
        }
    }

    var message: String {
        switch self {
        case .unreachable:
            String(localized: "Check your connection, then try again.")
        case .untrustedCertificate:
            String(localized: "The server’s certificate isn’t valid or isn’t trusted by this device.")
        case .contentProcessEnded:
            String(localized: "Tilecast Studio stopped unexpectedly several times.")
        case .other:
            String(localized: "Tilecast Studio couldn’t be loaded. Try again.")
        }
    }
}

extension MediaUploadError {
    /// Why one file did not upload, in words a person can act on.
    var message: String {
        switch self {
        case .unauthenticated:
            String(localized: "Tilecast isn’t signed in to this server. Sign in again.")
        case .unsupportedType:
            String(localized: "This server doesn’t accept this type of file.")
        case .tooLarge:
            String(localized: "This file is larger than the server allows.")
        case .insufficientStorage:
            String(localized: "The server has no space left.")
        case .rejected:
            String(localized: "The server didn’t accept this upload.")
        case .unavailable:
            String(localized: "Couldn’t reach the server. Check your connection and try again.")
        case .unreadable:
            String(localized: "Couldn’t read this file.")
        case .processingFailed:
            String(localized: "The server couldn’t process this file.")
        case .cancelled:
            String(localized: "Cancelled")
        }
    }
}
