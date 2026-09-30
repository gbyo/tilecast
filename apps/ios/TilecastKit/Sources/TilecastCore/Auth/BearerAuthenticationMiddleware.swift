import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Authenticates every generated-client request with the session's bearer
/// token. It is the only place native API authentication happens: no
/// operation adds its own credentials, and no request carries a cookie.
///
/// When the server answers 401, the rejected token is dropped and the
/// request is retried once with a newly rotated one, if its body can be
/// sent again. A second 401 is returned to the caller. A refused refresh
/// ends in `NativeAuthError.unauthenticated`, never in a retry loop.
struct BearerAuthenticationMiddleware: ClientMiddleware {
    let session: NativeAuthSession

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        request.headerFields[.cookie] = nil
        let token = try await session.accessToken()
        request.headerFields[.authorization] = "Bearer \(token)"
        let (response, responseBody) = try await next(request, body, baseURL)
        guard response.status == .unauthorized else { return (response, responseBody) }
        await session.accessTokenRejected(token)
        guard body == nil || body?.iterationBehavior == .multiple else { return (response, responseBody) }
        let retryToken = try await session.accessToken()
        guard retryToken != token else { return (response, responseBody) }
        request.headerFields[.authorization] = "Bearer \(retryToken)"
        return try await next(request, body, baseURL)
    }
}
