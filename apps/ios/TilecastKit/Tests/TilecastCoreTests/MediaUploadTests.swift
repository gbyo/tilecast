import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing
import TilecastAPI
@testable import TilecastCore

/// A Tilecast server's resumable upload endpoints, with the rules that
/// matter to a client: an offset that must match, a HEAD that reports it,
/// and a finalize that refuses an incomplete file. Faults can be injected
/// per request, so a test can drop an answer after the server applied it.
final class FakeUploadServer: @unchecked Sendable {
    enum Fault: Sendable {
        /// The chunk arrives and is kept, but the answer is lost.
        case dropAfterApplying
        /// The connection fails before the server sees the chunk.
        case dropBeforeApplying
        case status(Int)
        case redirect
    }

    struct Session {
        var index: Int
        var filename: String
        var mimeType: String
        var size: Int64
        var received = Data()
        var id: String { Self.uuid("0d3a1c55-7f6e-4a52-9d5a-6e2b8f9c1a", index) }
        var assetID: String { Self.uuid("5a9c2e77-1b34-4c0d-8e21-3f4a5b6c7d", index) }

        static func uuid(_ prefix: String, _ index: Int) -> String { prefix + String(format: "%02x", 0x10 + index) }
    }

    private let lock = NSLock()
    private var sessions: [Session] = []
    private var patchFaults: [Fault] = []
    private var createStatus = 201
    private var completeStatuses: [Int] = []
    private var completeBody: String?
    private var assetStatuses: [String] = ["ready"]
    private var _cancelled: [String] = []
    private var _completed: [String] = []

    /// The first session's ids, for the tests that upload one file.
    var sessionID: UUID { UUID(uuidString: Session.uuid("0d3a1c55-7f6e-4a52-9d5a-6e2b8f9c1a", 1))! }
    var assetID: UUID { UUID(uuidString: Session.uuid("5a9c2e77-1b34-4c0d-8e21-3f4a5b6c7d", 1))! }
    var cancelled: Bool { lock.withLock { !_cancelled.isEmpty } }
    var completed: Bool { lock.withLock { !_completed.isEmpty } }
    var completedCount: Int { lock.withLock { _completed.count } }
    var sessionCount: Int { lock.withLock { sessions.count } }
    /// What the most recent session received.
    var uploaded: Data { lock.withLock { sessions.last?.received ?? Data() } }
    var filename: String { lock.withLock { sessions.last?.filename ?? "" } }
    var mimeType: String { lock.withLock { sessions.last?.mimeType ?? "" } }
    var declaredSize: Int64 { lock.withLock { sessions.last?.size ?? 0 } }
    func failPatches(_ faults: Fault...) { lock.withLock { patchFaults = faults } }
    func failCreate(_ status: Int) { lock.withLock { createStatus = status } }
    func answerComplete(_ statuses: Int...) { lock.withLock { completeStatuses = statuses } }
    func answerCompleteBody(_ body: String) { lock.withLock { completeBody = body } }
    func processing(_ statuses: String...) { lock.withLock { assetStatuses = statuses } }

    private func sessionJSON(_ session: Session) -> String {
        #"{"data":{"id":"\#(session.id)","filename":"\#(session.filename)","mimeType":"\#(session.mimeType)","sizeBytes":\#(session.size),"offset":0,"status":"pending","expiresAt":"2026-10-01T12:00:00.5Z","uploadEndpoint":"/api/v1/uploads/\#(session.id)","maximumSizeBytes":10737418240}}"#
    }

    private func assetJSON(_ session: Session, status: String) -> String {
        #"{"data":{"id":"\#(session.assetID)","name":"clip","description":"","type":"image","originalFilename":"\#(session.filename)","declaredMimeType":"\#(session.mimeType)","detectedMimeType":"\#(session.mimeType)","sha256":"\#(String(repeating: "a", count: 64))","originalSize":\#(session.size),"metadata":{},"processingStatus":"\#(status)","createdAt":"2026-09-29T12:00:00.5Z","updatedAt":"2026-09-29T12:00:00.5Z","variants":[],"playlistUsage":0,"layoutUsage":[],"tags":[],"collectionIds":[]}}"#
    }

    func handle(_ request: StubProtocol.Seen) -> StubProtocol.Answer {
        lock.withLock {
            let path = request.url.path
            let uploads = "/api/v1/uploads"
            if request.method == "POST", path == uploads {
                if createStatus != 201 { return .init(status: createStatus, body: "{}") }
                let json = request.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
                let session = Session(
                    index: sessions.count + 1,
                    filename: json["filename"] as? String ?? "",
                    mimeType: json["mimeType"] as? String ?? "",
                    size: (json["sizeBytes"] as? NSNumber)?.int64Value ?? 0
                )
                sessions.append(session)
                return .init(status: 201, body: sessionJSON(session))
            }
            if request.method == "GET", path.hasPrefix("/api/v1/assets/") {
                let id = String(path.dropFirst("/api/v1/assets/".count))
                guard let session = sessions.first(where: { $0.assetID == id }) else { return .init(status: 404, body: "{}") }
                let status = assetStatuses.count > 1 ? assetStatuses.removeFirst() : assetStatuses[0]
                return .init(status: 200, body: assetJSON(session, status: status))
            }
            guard path.hasPrefix(uploads + "/") else { return .init(status: 404, body: "{}") }
            let rest = path.dropFirst(uploads.count + 1)
            let complete = rest.hasSuffix("/complete")
            let id = String(complete ? rest.dropLast("/complete".count) : rest)
            guard let index = sessions.firstIndex(where: { $0.id == id }) else { return .init(status: 404, body: "{}") }
            switch (request.method, complete) {
            case ("HEAD", false):
                let session = sessions[index]
                return .init(status: 204, headers: ["Upload-Offset": "\(session.received.count)", "Upload-Length": "\(session.size)", "Upload-Status": "uploading"])
            case ("PATCH", false):
                let offset = Int(request.headers["Upload-Offset"] ?? "") ?? -1
                if !patchFaults.isEmpty {
                    switch patchFaults.removeFirst() {
                    case .dropAfterApplying:
                        if offset == sessions[index].received.count { sessions[index].received.append(request.body ?? Data()) }
                        return .init(status: 0, failure: .networkConnectionLost)
                    case .dropBeforeApplying:
                        return .init(status: 0, failure: .networkConnectionLost)
                    case .status(let status):
                        return .init(status: status, body: "{}")
                    case .redirect:
                        return .init(status: 307, headers: ["Location": "https://evil.example/upload"], redirects: true)
                    }
                }
                guard offset == sessions[index].received.count else { return .init(status: 409, body: "{}") }
                sessions[index].received.append(request.body ?? Data())
                return .init(status: 204, headers: ["Upload-Offset": "\(sessions[index].received.count)"])
            case ("POST", true):
                if !completeStatuses.isEmpty {
                    let status = completeStatuses.count > 1 ? completeStatuses.removeFirst() : completeStatuses[0]
                    if status != 200 { return .init(status: status, body: "{}") }
                }
                guard Int64(sessions[index].received.count) == sessions[index].size else { return .init(status: 409, body: "{}") }
                _completed.append(id)
                return .init(status: 200, body: completeBody ?? assetJSON(sessions[index], status: "queued"))
            case ("DELETE", false):
                _cancelled.append(id)
                return .init(status: 204)
            default:
                return .init(status: 404, body: "{}")
            }
        }
    }
}

/// A file in a private temporary directory that the test removes.
final class TemporaryMedia: @unchecked Sendable {
    let directory = FileManager.default.temporaryDirectory.appending(path: "TilecastTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    init() { try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
    deinit { try? FileManager.default.removeItem(at: directory) }

    func file(named name: String = "clip.jpg", bytes: Data) throws -> MediaIntakeFile {
        let url = directory.appending(path: UUID().uuidString)
        try bytes.write(to: url)
        return MediaIntakeFile(displayName: name, url: url, size: Int64(bytes.count), mimeType: "image/jpeg")
    }
}

extension StubbedHTTPTests {
    @Suite struct MediaUploaderTests {
        let sessionServer = FakeSessionServer()
        let store = InMemoryCredentialStore()
        let upload = FakeUploadServer()
        let media = TemporaryMedia()
        let bytes = Data((0..<10).map { UInt8($0 + 65) })

        init() {
            StubProtocol.reset()
            let upload = upload
            StubProtocol.handler = { upload.handle($0) }
        }

        func uploader(chunkSize: Int = 4, retry: UploadRetryPolicy = .immediate) async throws -> (MediaUploader, NativeAuthSession) {
            let session = NativeAuthSession(
                key: NativeCredentialKey(serverID: UUID(), installationID: UUID()),
                address: address("signage.example.org"), exchanger: sessionServer, store: store
            )
            _ = try await session.completeSignIn(code: "c", verifier: "v")
            return (MediaUploader(client: session.makeClient(transport: stubTransport()), chunkSize: chunkSize, retry: retry), session)
        }

        func patchOffsets() -> [Int] {
            StubProtocol.requests.filter { $0.method == "PATCH" }.compactMap { Int($0.headers["Upload-Offset"] ?? "") }
        }

        // MARK: Transport

        @Test func uploadsInChunksWithTheBearerTokenAndNothingElse() async throws {
            // Cookies a shared store would offer this host must not be sent.
            HTTPCookieStorage.shared.setCookie(studioCookie(host: "signage.example.org", value: "leaked"))
            defer { HTTPCookieStorage.shared.cookies?.forEach(HTTPCookieStorage.shared.deleteCookie) }
            let (uploader, _) = try await uploader()
            let file = try media.file(bytes: bytes)

            let result = try await uploader.upload(file)

            #expect(result.assetID == upload.assetID)
            #expect(upload.uploaded == bytes)
            #expect(patchOffsets() == [0, 4, 8])
            #expect(upload.filename == "clip.jpg")
            #expect(upload.mimeType == "image/jpeg")
            #expect(upload.declaredSize == 10)
            for request in StubProtocol.requests {
                #expect(request.url.host == "signage.example.org")
                #expect(request.url.scheme == "https")
                #expect(request.headers["Authorization"] == "Bearer tca_access1")
                let names = request.headers.keys.map { $0.lowercased() }
                #expect(!names.contains("cookie"), "no cookie on \(request.method)")
                #expect(!names.contains("x-csrf-token"), "no CSRF token on \(request.method)")
            }
            let chunk = try #require(StubProtocol.requests.first { $0.method == "PATCH" })
            #expect(chunk.headers["Content-Type"] == "application/offset+octet-stream")
        }

        @Test func reportsProgressAsTheServerHoldsMoreBytes() async throws {
            let (uploader, _) = try await uploader()
            let file = try media.file(bytes: bytes)
            let seen = Locked<[Int64]>([])
            _ = try await uploader.upload(file) { sent in seen.mutate { $0.append(sent) } }
            #expect(seen.value == [4, 8, 10])
        }

        // MARK: Recovery

        @Test func continuesFromTheServersOffsetWhenAnAnswerWasLost() async throws {
            upload.failPatches(.dropAfterApplying)
            let (uploader, _) = try await uploader()
            _ = try await uploader.upload(try media.file(bytes: bytes))

            #expect(upload.uploaded == bytes)
            // The first chunk arrived and is not sent again.
            #expect(patchOffsets() == [0, 4, 8])
            #expect(StubProtocol.requests.contains { $0.method == "HEAD" }, "the client asked the server for its offset")
        }

        @Test func sendsAChunkAgainThatNeverArrived() async throws {
            upload.failPatches(.dropBeforeApplying)
            let (uploader, _) = try await uploader()
            _ = try await uploader.upload(try media.file(bytes: bytes))
            #expect(upload.uploaded == bytes)
            #expect(patchOffsets() == [0, 0, 4, 8])
        }

        @Test func retriesAServerErrorAndAnUnreachableServer() async throws {
            upload.failPatches(.status(503), .dropBeforeApplying, .status(429))
            let (uploader, _) = try await uploader()
            _ = try await uploader.upload(try media.file(bytes: bytes))
            #expect(upload.uploaded == bytes)
        }

        @Test func resyncsWhenTheServerReportsAnOffsetMismatch() async throws {
            upload.failPatches(.status(409))
            let (uploader, _) = try await uploader()
            _ = try await uploader.upload(try media.file(bytes: bytes))
            #expect(upload.uploaded == bytes)
        }

        @Test func givesUpAfterTheRetryLimitAndCancelsTheSession() async throws {
            upload.failPatches(.dropBeforeApplying, .dropBeforeApplying, .dropBeforeApplying, .dropBeforeApplying, .dropBeforeApplying, .dropBeforeApplying)
            let (uploader, _) = try await uploader(retry: UploadRetryPolicy(maximumAttempts: 3) { _ in .zero })
            await #expect(throws: MediaUploadError.unavailable) { try await uploader.upload(try media.file(bytes: bytes)) }
            #expect(patchOffsets().count == 3)
            #expect(upload.cancelled, "an upload that gave up does not leave its session behind")
        }

        @Test func finishesAnUploadWhoseFinalAnswerWasNotUnderstood() async throws {
            upload.answerCompleteBody(#"{"data":{"surprise":true}}"#)
            let (uploader, _) = try await uploader()
            let result = try await uploader.upload(try media.file(bytes: bytes))
            #expect(result == UploadedMedia(assetID: nil), "the server finalized it, whatever it said")
            #expect(upload.completed)
            #expect(!upload.cancelled)
        }

        @Test func sendsTheRestWhenTheServerSaysTheUploadIsIncomplete() async throws {
            upload.answerComplete(409, 200)
            let (uploader, _) = try await uploader()
            _ = try await uploader.upload(try media.file(bytes: bytes))
            #expect(upload.completed)
        }

        // MARK: Refusals

        @Test func neverFollowsARedirectWithTheToken() async throws {
            upload.failPatches(.redirect)
            let (uploader, _) = try await uploader()
            await #expect(throws: MediaUploadError.rejected(status: 307)) { try await uploader.upload(try media.file(bytes: bytes)) }
            #expect(StubProtocol.requests.allSatisfy { $0.url.host == "signage.example.org" }, "nothing was sent to the redirect target")
        }

        @Test(arguments: [(413, MediaUploadError.tooLarge), (507, .insufficientStorage), (401, .unauthenticated), (403, .unauthenticated), (400, .rejected(status: 400))])
        func mapsAnUploadRefusal(_ status: Int, _ expected: MediaUploadError) async throws {
            upload.failCreate(status)
            let (uploader, _) = try await uploader()
            await #expect(throws: expected) { try await uploader.upload(try media.file(bytes: bytes)) }
        }

        @Test func mapsAnUnsupportedMediaType() async throws {
            upload.answerComplete(415)
            let (uploader, _) = try await uploader()
            await #expect(throws: MediaUploadError.unsupportedType) { try await uploader.upload(try media.file(bytes: bytes)) }
        }

        @Test func aRefusedTokenRotatesOnceThenEndsUnauthenticated() async throws {
            upload.failCreate(401)
            let (uploader, _) = try await uploader()
            await #expect(throws: MediaUploadError.unauthenticated) { try await uploader.upload(try media.file(bytes: bytes)) }
            #expect(sessionServer.refreshCalls.count == 1, "one rotation, never a loop")
        }

        @Test func refusesAnEmptyOrMissingFile() async throws {
            let (uploader, _) = try await uploader()
            await #expect(throws: MediaUploadError.unreadable) { try await uploader.upload(try media.file(bytes: Data())) }
            let missing = MediaIntakeFile(displayName: "x", url: media.directory.appending(path: "nope"), size: 5, mimeType: "image/jpeg")
            await #expect(throws: MediaUploadError.unreadable) { try await uploader.upload(missing) }
            #expect(StubProtocol.requests.isEmpty, "nothing is created for a file that cannot be read")
        }

        // MARK: Cancellation

        @Test func cancellingStopsTheUploadAndCancelsTheSession() async throws {
            let (uploader, _) = try await uploader(chunkSize: 1)
            let file = try media.file(bytes: bytes)
            let task = Task {
                try await uploader.upload(file) { sent in if sent >= 3 { withUnsafeCurrentTask { $0?.cancel() } } }
            }
            let outcome = await task.result
            #expect(outcome.isFailure(MediaUploadError.cancelled))
            #expect(upload.cancelled)
            #expect(upload.uploaded.count < bytes.count)
        }

        // MARK: Processing

        @Test func followsHowTheServerProcessesTheAsset() async throws {
            upload.processing("processing", "ready")
            let (uploader, _) = try await uploader()
            _ = try await uploader.upload(try media.file(bytes: bytes))
            #expect(await uploader.processingState(of: upload.assetID) == .processing(fraction: nil))
            #expect(await uploader.processingState(of: upload.assetID) == .ready)
            upload.processing("failed")
            #expect(await uploader.processingState(of: upload.assetID) == .failed)
        }

        @Test func anUnreadableStatusIsUnknownNotAFailure() async throws {
            let (uploader, _) = try await uploader()
            StubProtocol.handler = { _ in .init(status: 200, body: #"{"data":{"processingStatus":"brand-new-status"}}"#) }
            #expect(await uploader.processingState(of: upload.assetID) == .unknown)
        }
    }
}

/// A value shared with `@Sendable` callbacks.
final class Locked<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value { lock.withLock { stored } }
    func mutate(_ change: (inout Value) -> Void) { lock.withLock { change(&stored) } }
}

extension Result where Failure == MediaUploadError {
    func isFailure(_ expected: MediaUploadError) -> Bool {
        if case .failure(let error) = self { error == expected } else { false }
    }
}
extension Result where Failure == any Error {
    func isFailure(_ expected: MediaUploadError) -> Bool {
        if case .failure(let error) = self { (error as? MediaUploadError) == expected } else { false }
    }
}
