import Foundation
import HTTPTypes
import OpenAPIRuntime
import TilecastAPI

/// Why one upload ended without an asset.
public enum MediaUploadError: Error, Equatable, Sendable {
    /// The native credential is missing or refused. A new sign-in restores it.
    case unauthenticated
    /// The server does not accept this kind of media.
    case unsupportedType
    /// The file is larger than the server's upload limit.
    case tooLarge
    /// The server has no room to keep the file.
    case insufficientStorage
    /// The server answered with a status this upload cannot recover from.
    case rejected(status: Int)
    /// The server could not be reached, after the retries the policy allows.
    case unavailable
    /// The file could not be read from staging.
    case unreadable
    /// The server accepted the file but could not process it, for example
    /// because it is not valid media.
    case processingFailed
    case cancelled
}

/// A finished upload. `assetID` is nil when the server accepted the upload
/// but answered in a shape this app does not know, which is still a success.
public struct UploadedMedia: Equatable, Sendable {
    public var assetID: UUID?
}

/// How the server processes an uploaded asset, as far as this app tracks it.
public enum MediaProcessingState: Equatable, Sendable {
    case processing(fraction: Double?)
    case ready
    case failed
    /// The status could not be read. The upload itself already succeeded.
    case unknown
}

/// How an upload retries transient failures.
public struct UploadRetryPolicy: Sendable {
    /// Consecutive failed attempts on one step before the upload gives up.
    public var maximumAttempts: Int
    public var delay: @Sendable (_ failedAttempts: Int) -> Duration

    public init(maximumAttempts: Int = 5, delay: @escaping @Sendable (Int) -> Duration = { .milliseconds(min(400 * (1 << ($0 - 1)), 5_000)) }) {
        self.maximumAttempts = maximumAttempts
        self.delay = delay
    }

    public static let immediate = UploadRetryPolicy(maximumAttempts: 4) { _ in .zero }
}

/// Uploads one staged file with Tilecast's existing resumable upload
/// protocol, through the generated client. It adds no client of its own.
///
/// Authentication, cookie removal, and the refusal of redirects belong to
/// the client's transport and middleware, so this type never sees a
/// credential and never sends a cookie or a CSRF token.
///
/// The protocol is: create a session, append chunks at an offset, finalize.
/// When a request fails or its answer is lost, the upload asks the server
/// for its offset and continues from there, so a chunk that arrived is not
/// sent again and one that did not is not skipped.
public struct MediaUploader: Sendable {
    public static let defaultChunkSize = 2 * 1024 * 1024

    let client: Client
    let chunkSize: Int
    let retry: UploadRetryPolicy

    public init(client: Client, chunkSize: Int = MediaUploader.defaultChunkSize, retry: UploadRetryPolicy = .init()) {
        self.client = client
        self.chunkSize = max(1, chunkSize)
        self.retry = retry
    }

    /// Uploads `file`, reporting the bytes the server holds as they grow.
    public func upload(_ file: MediaIntakeFile, progress: @Sendable (Int64) -> Void = { _ in }) async throws(MediaUploadError) -> UploadedMedia {
        guard file.size > 0, let handle = try? FileHandle(forReadingFrom: file.url) else { throw .unreadable }
        defer { try? handle.close() }
        let session = try await createSession(for: file)
        do {
            try await send(file, session: session, handle: handle, progress: progress)
            var resyncs = 0
            while true {
                switch try await finalize(session) {
                case .done(let media): return media
                case .incomplete:
                    // The server does not hold every byte. Send the rest, a bounded number of times.
                    resyncs += 1
                    guard resyncs <= 2 else { throw MediaUploadError.rejected(status: 409) }
                    try await send(file, session: session, handle: handle, progress: progress)
                }
            }
        } catch {
            // The server keeps an abandoned session until it expires, but
            // there is no reason to leave one behind on purpose.
            let failure = MediaUploadError(error)
            if failure != .unauthenticated { await cancel(session) }
            throw failure
        }
    }

    /// Reads how far the server got with an asset. It never throws: an
    /// unreadable status is `.unknown`, because the upload already succeeded.
    public func processingState(of assetID: UUID) async -> MediaProcessingState {
        do {
            let output = try await client.getAsset(.init(path: .init(id: assetID.uuidString.lowercased())))
            guard case .ok(let ok) = output, case .json(let body) = ok.body else { return .unknown }
            switch body.data.processingStatus {
            case .ready: return .ready
            case .failed, .deleting, .deleted: return .failed
            default: return .processing(fraction: body.data.processingProgress)
            }
        } catch {
            return .unknown
        }
    }

    // MARK: Protocol steps

    private struct Session {
        var id: String
        var offset: Int64
    }

    private enum Finalized {
        case done(UploadedMedia)
        case incomplete
    }

    private func createSession(for file: MediaIntakeFile) async throws(MediaUploadError) -> Session {
        try await retrying {
            let output = try await client.createUploadSession(.init(body: .json(.init(
                filename: file.displayName,
                mimeType: file.mimeType,
                sizeBytes: file.size
            ))))
            switch output {
            case .created(let created):
                guard case .json(let body) = created.body, let id = UUID(uuidString: body.data.id) else {
                    throw MediaUploadError.rejected(status: 201)
                }
                return Session(id: id.uuidString.lowercased(), offset: max(0, min(body.data.offset, file.size)))
            case .contentTooLarge: throw MediaUploadError.tooLarge
            case .code507: throw MediaUploadError.insufficientStorage
            case .undocumented(let status, _): throw MediaUploadError(status: status)
            }
        }
    }

    /// Sends every byte the server does not yet hold, starting at the
    /// session's offset. After a failed request it asks the server where it
    /// is, and continues from there.
    private func send(_ file: MediaIntakeFile, session: Session, handle: FileHandle, progress: @Sendable (Int64) -> Void) async throws(MediaUploadError) {
        var offset = session.offset
        var failures = 0
        while offset < file.size {
            if Task.isCancelled { throw .cancelled }
            let length = Int(min(Int64(chunkSize), file.size - offset))
            let chunk: Data
            do {
                try handle.seek(toOffset: UInt64(offset))
                chunk = try handle.read(upToCount: length) ?? Data()
            } catch {
                throw .unreadable
            }
            guard chunk.count == length else { throw .unreadable }
            do {
                let output = try await client.appendUploadBytes(.init(
                    path: .init(id: session.id),
                    headers: .init(uploadOffset: offset),
                    body: .applicationOffsetOctetStream(HTTPBody(chunk))
                ))
                switch output {
                case .noContent:
                    offset += Int64(length)
                    failures = 0
                case .conflict:
                    // The server holds a different number of bytes than this
                    // upload thought: a chunk arrived whose answer was lost.
                    offset = try await serverOffset(of: session, size: file.size, fallback: offset)
                case .undocumented(let status, _):
                    throw MediaUploadError(status: status)
                }
                progress(offset)
            } catch {
                let failure = MediaUploadError(error)
                guard failure.isTransient else { throw failure }
                failures += 1
                guard failures < retry.maximumAttempts else { throw failure }
                do { try await Task.sleep(for: retry.delay(failures)) } catch { throw .cancelled }
                offset = try await serverOffset(of: session, size: file.size, fallback: offset)
            }
        }
    }

    private func serverOffset(of session: Session, size: Int64, fallback: Int64) async throws(MediaUploadError) -> Int64 {
        try await retrying {
            let output = try await client.inspectUploadSession(.init(path: .init(id: session.id)))
            switch output {
            case .noContent(let response):
                guard let offset = response.headers.uploadOffset, offset >= 0 else { return fallback }
                return min(offset, size)
            case .undocumented(let status, _):
                throw MediaUploadError(status: status)
            }
        }
    }

    private func finalize(_ session: Session) async throws(MediaUploadError) -> Finalized {
        try await retrying {
            do {
                switch try await client.completeUpload(.init(path: .init(id: session.id))) {
                case .ok(let ok):
                    guard case .json(let body) = ok.body else { return .done(UploadedMedia(assetID: nil)) }
                    return .done(UploadedMedia(assetID: UUID(uuidString: body.data.id)))
                case .conflict: return .incomplete
                case .unsupportedMediaType: throw MediaUploadError.unsupportedType
                case .undocumented(let status, _): throw MediaUploadError(status: status)
                }
            } catch let error as ClientError where error.response?.status == .ok {
                // The server finalized the upload but answered in a shape
                // this app does not know. That is a finished upload.
                return .done(UploadedMedia(assetID: nil))
            }
        }
    }

    private func cancel(_ session: Session) async {
        // Best effort, and detached so a cancelled caller still sends it.
        let client = client
        let id = session.id
        await Task.detached { _ = try? await client.cancelUpload(.init(path: .init(id: id))) }.value
    }

    /// Runs one protocol step, and repeats it after a transient failure
    /// until the policy gives up.
    private func retrying<T>(_ operation: () async throws -> T) async throws(MediaUploadError) -> T {
        var failures = 0
        while true {
            if Task.isCancelled { throw .cancelled }
            do {
                return try await operation()
            } catch {
                let failure = MediaUploadError(error)
                guard failure.isTransient else { throw failure }
                failures += 1
                guard failures < retry.maximumAttempts else { throw failure }
                do { try await Task.sleep(for: retry.delay(failures)) } catch { throw .cancelled }
            }
        }
    }
}

extension MediaUploadError {
    /// The failure a response status means.
    init(status: Int) {
        switch status {
        case 401, 403: self = .unauthenticated
        case 413: self = .tooLarge
        case 415: self = .unsupportedType
        case 507: self = .insufficientStorage
        default: self = .rejected(status: status)
        }
    }

    /// The failure any error a step throws means.
    init(_ error: any Error) {
        if let failure = error as? MediaUploadError {
            self = failure
        } else if error is CancellationError {
            self = .cancelled
        } else if let error = error as? ClientError {
            if error.underlyingError is CancellationError || (error.underlyingError as? URLError)?.code == .cancelled {
                self = .cancelled
            } else if let auth = error.underlyingError as? NativeAuthError {
                self = auth == .unauthenticated ? .unauthenticated : .unavailable
            } else {
                self = .unavailable
            }
        } else {
            self = .unavailable
        }
    }

    /// Whether another attempt can succeed: the server could not be
    /// reached, or answered that it could not serve the request now.
    var isTransient: Bool {
        switch self {
        case .unavailable: true
        case .rejected(let status): status >= 500 || status == 408 || status == 429
        default: false
        }
    }
}
