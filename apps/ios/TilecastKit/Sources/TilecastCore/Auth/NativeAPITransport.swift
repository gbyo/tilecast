import Foundation
import OpenAPIRuntime
import OpenAPIURLSession
import TilecastAPI

/// The HTTP stack for native API calls. It shares nothing with Studio's
/// WebKit data store: no cookies are stored or sent, nothing is cached, no
/// URL credential is offered, and redirects are refused, so an
/// `Authorization` header or an authorization code is sent only to the
/// server origin it was built for. Certificate evaluation is the system's.
public enum NativeAPITransport {
    public static func makeSession(protocolClasses: [AnyClass]? = nil) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 60
        configuration.waitsForConnectivity = false
        if let protocolClasses { configuration.protocolClasses = protocolClasses }
        return URLSession(configuration: configuration, delegate: RefusingRedirects(), delegateQueue: nil)
    }

    public static func makeTransport(session: URLSession = makeSession()) -> any ClientTransport {
        URLSessionTransport(configuration: .init(session: session))
    }

    /// A generated client for one verified server.
    static func client(
        for address: ServerAddress,
        transport: any ClientTransport,
        middlewares: [any ClientMiddleware] = []
    ) -> Client {
        Client(
            serverURL: address.url,
            configuration: .init(dateTranscoder: RFC3339DateTranscoder()),
            transport: transport,
            middlewares: middlewares
        )
    }
}

/// Answers every redirect with the redirect response itself, which the
/// generated client reports as an undocumented status.
final class RefusingRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}

/// Tilecast encodes times as RFC 3339 with up to nine fractional digits,
/// and without a fraction when it is zero. The runtime's default transcoder
/// accepts only the second form.
struct RFC3339DateTranscoder: DateTranscoder {
    func encode(_ date: Date) throws -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    func decode(_ string: String) throws -> Date {
        try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(string)
    }
}
