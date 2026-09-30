import Foundation

/// The parts of a Tilecast server that native media intake talks to: the
/// iOS session endpoint that rotates a refresh token, and the resumable
/// upload endpoints, with the rules that matter to a client. It records what
/// the wire carried, so a test can prove the request used the bearer token
/// and sent no cookie and no CSRF token.
final class FixtureUploadAPI: @unchecked Sendable {
    struct Request {
        var method: String
        var path: String
        var headers: [String: String]
        var body: Data
    }

    struct Response {
        var status: Int
        var headers: [String: String] = ["Content-Type": "application/json"]
        var body: Data = Data()
    }

    struct Upload {
        var id: String
        var filename: String
        var mimeType: String
        var size: Int
        var data = Data()
        var completed = false
    }

    private let lock = NSLock()
    private var _uploads: [Upload] = []
    private var _seen: [Request] = []
    private var rotations = 0

    var uploads: [Upload] { lock.withLock { _uploads } }
    var seen: [Request] { lock.withLock { _seen } }

    func handles(_ path: String) -> Bool {
        path == "/api/v1/oauth/ios-session" || path.hasPrefix("/api/v1/uploads") || path.hasPrefix("/api/v1/assets/")
    }

    func respond(to request: Request) -> Response {
        lock.withLock {
            _seen.append(request)
            if request.path == "/api/v1/oauth/ios-session" { return rotate() }
            // Every other endpoint needs the native bearer token, as the real API does.
            guard request.headers["authorization"]?.hasPrefix("Bearer tca_") == true else {
                return Response(status: 401, body: Data(#"{"error":{"code":"authentication_required","message":"no"}}"#.utf8))
            }
            return route(request)
        }
    }

    private func rotate() -> Response {
        rotations += 1
        let expires = Date.now.addingTimeInterval(900).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        let body = #"{"data":{"authenticated":false,"credential":{"access_token":"tca_fixture\#(rotations)","refresh_token":"tcr_fixture\#(rotations)","token_type":"Bearer","expires_at":"\#(expires)"}}}"#
        return Response(status: 200, body: Data(body.utf8))
    }

    private func route(_ request: Request) -> Response {
        let uploads = "/api/v1/uploads"
        if request.method == "POST", request.path == uploads {
            let json = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
            let upload = Upload(
                id: Self.uuid("0d3a1c55-7f6e-4a52-9d5a-6e2b8f9c1a", _uploads.count + 1),
                filename: json["filename"] as? String ?? "",
                mimeType: json["mimeType"] as? String ?? "",
                size: (json["sizeBytes"] as? NSNumber)?.intValue ?? 0
            )
            _uploads.append(upload)
            let body = #"{"data":{"id":"\#(upload.id)","filename":"\#(upload.filename)","mimeType":"\#(upload.mimeType)","sizeBytes":\#(upload.size),"offset":0,"status":"pending","expiresAt":"2030-01-01T00:00:00.5Z","uploadEndpoint":"/api/v1/uploads/\#(upload.id)","maximumSizeBytes":10737418240}}"#
            return Response(status: 201, body: Data(body.utf8))
        }
        if request.method == "GET", request.path.hasPrefix("/api/v1/assets/") {
            let id = String(request.path.dropFirst("/api/v1/assets/".count))
            guard let upload = _uploads.first(where: { Self.assetID(for: $0) == id }) else { return Response(status: 404) }
            return Response(status: 200, body: Data(assetJSON(upload, status: "ready").utf8))
        }
        guard request.path.hasPrefix(uploads + "/") else { return Response(status: 404) }
        let rest = request.path.dropFirst(uploads.count + 1)
        let complete = rest.hasSuffix("/complete")
        let id = String(complete ? rest.dropLast("/complete".count) : rest)
        guard let index = _uploads.firstIndex(where: { $0.id == id }) else { return Response(status: 404) }
        switch (request.method, complete) {
        case ("HEAD", false):
            return Response(status: 204, headers: ["Upload-Offset": "\(_uploads[index].data.count)", "Upload-Length": "\(_uploads[index].size)", "Upload-Status": "uploading"])
        case ("PATCH", false):
            let offset = Int(request.headers["upload-offset"] ?? "") ?? -1
            guard offset == _uploads[index].data.count else { return Response(status: 409) }
            _uploads[index].data.append(request.body)
            return Response(status: 204, headers: ["Upload-Offset": "\(_uploads[index].data.count)"])
        case ("POST", true):
            guard _uploads[index].data.count == _uploads[index].size else { return Response(status: 409) }
            _uploads[index].completed = true
            return Response(status: 200, body: Data(assetJSON(_uploads[index], status: "queued").utf8))
        case ("DELETE", false):
            return Response(status: 204)
        default:
            return Response(status: 404)
        }
    }

    private static func uuid(_ prefix: String, _ index: Int) -> String { prefix + String(format: "%02x", 0x10 + index) }

    private static func assetID(for upload: Upload) -> String {
        upload.id.replacingOccurrences(of: "0d3a1c55-7f6e-4a52-9d5a-6e2b8f9c1a", with: "5a9c2e77-1b34-4c0d-8e21-3f4a5b6c7d")
    }

    private func assetJSON(_ upload: Upload, status: String) -> String {
        #"{"data":{"id":"\#(Self.assetID(for: upload))","name":"fixture","description":"","type":"image","originalFilename":"\#(upload.filename)","declaredMimeType":"\#(upload.mimeType)","detectedMimeType":"\#(upload.mimeType)","sha256":"\#(String(repeating: "a", count: 64))","originalSize":\#(upload.size),"metadata":{},"processingStatus":"\#(status)","createdAt":"2026-09-29T12:00:00.5Z","updatedAt":"2026-09-29T12:00:00.5Z","variants":[],"playlistUsage":0,"layoutUsage":[],"tags":[],"collectionIds":[]}}"#
    }
}
