import Foundation
import Observation

/// Native media intake for the connected server.
///
/// Studio asks with `system/media-intake`; the app shows Apple's own
/// pickers, uploads what the person chose with the native API credential,
/// and tells Studio only how it ended. Studio stays the product interface
/// for browsing, organizing, and publishing the media.
///
/// The coordinator holds no product data: an item is a file name, a byte
/// count, and a state. It never sends file bytes, a path, or a credential
/// to Studio, and it removes every temporary copy when an intake ends, the
/// server changes, or the person signs out.
@MainActor
@Observable
public final class MediaIntakeCoordinator {
    public enum Phase: Equatable, Sendable {
        case idle
        /// The system picker is up.
        case choosing
        /// Files are being copied and uploaded.
        case transferring
        /// Every upload ended. The progress sheet waits for Done.
        case finished
    }

    public enum ItemState: Equatable, Sendable {
        case preparing
        case uploading
        /// The server accepted the file and is inspecting or encoding it.
        case processing(fraction: Double?)
        case completed
        case failed(MediaUploadError)
        case cancelled

        var isSettled: Bool {
            switch self {
            case .completed, .failed, .cancelled: true
            default: false
            }
        }
    }

    public struct Item: Identifiable, Equatable, Sendable {
        public let id = UUID()
        /// Nil until the file is copied. A picked file's name is display text only.
        public var name: String?
        public var state: ItemState = .preparing
        public var sentBytes: Int64 = 0
        public var totalBytes: Int64 = 0
        /// The server accepted every byte and finalized the upload.
        public var isUploaded = false

        public var fraction: Double {
            totalBytes > 0 ? min(1, Double(sentBytes) / Double(totalBytes)) : 0
        }
    }

    public private(set) var phase: Phase = .idle
    /// The request Studio made, while an intake is active. It says which
    /// media kinds the picker offers.
    public private(set) var request: MediaIntakeRequest?
    public private(set) var items: [Item] = []

    @ObservationIgnored private let staging: MediaStaging
    @ObservationIgnored private let makeUploader: @Sendable (NativeAuthSession) -> MediaUploader
    @ObservationIgnored private let pollInterval: Duration
    @ObservationIgnored private let maximumPolls: Int
    @ObservationIgnored private weak var bridge: StudioBridge?
    @ObservationIgnored private var auth: NativeAuthSession?
    @ObservationIgnored private var transfer: Task<Void, Never>?
    @ObservationIgnored private var directory: URL?
    @ObservationIgnored private var userCancelled = false
    /// Incremented whenever an intake ends, so a transfer that is still
    /// unwinding cannot change what a newer intake shows.
    @ObservationIgnored private var generation = 0
    /// Tells Studio how an intake ended. Tests replace it to see the result.
    @ObservationIgnored var report: @MainActor (_ requestID: String, MediaIntakeOutcome, _ uploadedCount: Int) async -> Void = { _, _, _ in }

    public init(
        staging: MediaStaging = MediaStaging(),
        pollInterval: Duration = .milliseconds(1500),
        maximumPolls: Int = 120,
        makeUploader: @escaping @Sendable (NativeAuthSession) -> MediaUploader = { MediaUploader(client: $0.makeClient()) }
    ) {
        self.staging = staging
        self.pollInterval = pollInterval
        self.maximumPolls = maximumPolls
        self.makeUploader = makeUploader
    }

    /// Removes temporary media an earlier run of the app left behind. Call
    /// once at launch, before any intake can start.
    public func sweepStaging() {
        staging.sweep()
    }

    // MARK: Connection

    /// Connects the coordinator to the main Studio page of the connected
    /// server, and to that server's native credential.
    func attach(bridge: StudioBridge, auth: NativeAuthSession) {
        reset()
        self.bridge = bridge
        self.auth = auth
        report = { [weak bridge] requestID, outcome, count in
            await bridge?.sendMediaIntakeCompleted(requestID: requestID, outcome: outcome, uploadedCount: count)
        }
        bridge.isMediaIntakeAvailable = { [weak self] in self?.canBegin ?? false }
        bridge.onMediaIntake = { [weak self] request in self?.begin(request) ?? false }
    }

    /// Ends any intake without a word to Studio, and removes its temporary
    /// files: the server changed.
    public func detach() {
        reset()
        bridge = nil
        auth = nil
    }

    /// Ends any intake and removes its temporary files, but stays connected:
    /// the person signed out, and may sign in again to the same server.
    public func cancelActive() {
        reset()
    }

    /// Whether an intake can start now: it needs the native credential, so
    /// a server released before native API access keeps Studio's uploader.
    public var canBegin: Bool {
        phase == .idle && auth?.storesCredential == true
    }

    // MARK: Choosing

    func begin(_ request: MediaIntakeRequest) -> Bool {
        guard canBegin else { return false }
        self.request = request
        userCancelled = false
        items = []
        phase = .choosing
        return true
    }

    /// The person closed the picker without choosing anything.
    public func pickerCancelled() {
        guard phase == .choosing else { return }
        conclude(outcomeIfNothingUploaded: .cancelled)
    }

    /// The picker could not produce a selection.
    public func pickerFailed() {
        guard phase == .choosing else { return }
        conclude(outcomeIfNothingUploaded: .failed)
    }

    /// The person chose these items. Nothing is copied or uploaded until now.
    public func startTransfer(_ sources: [any MediaIntakeSource]) {
        guard phase == .choosing, let auth else { return }
        guard !sources.isEmpty else { return pickerCancelled() }
        items = sources.map { _ in Item() }
        phase = .transferring
        let uploader = makeUploader(auth)
        let generation = generation
        transfer = Task { [weak self] in
            await self?.run(sources, uploader: uploader, generation: generation)
        }
    }

    // MARK: Transfer

    private func run(_ sources: [any MediaIntakeSource], uploader: MediaUploader, generation: Int) async {
        let directory: URL
        do {
            directory = try staging.makeDirectory()
        } catch {
            guard generation == self.generation else { return }
            for index in items.indices { items[index].state = .failed(.unreadable) }
            return conclude(outcomeIfNothingUploaded: .failed)
        }
        self.directory = directory
        var mediaIDs: [Int: UUID] = [:]
        for (index, source) in sources.enumerated() {
            guard generation == self.generation else { return }
            if Task.isCancelled {
                items[index].state = .cancelled
                continue
            }
            let file: MediaIntakeFile
            do {
                file = try await source.materialize(into: directory, staging: staging)
            } catch {
                guard generation == self.generation else { return }
                items[index].state = Task.isCancelled ? .cancelled : .failed(.unreadable)
                continue
            }
            guard generation == self.generation else {
                try? FileManager.default.removeItem(at: file.url)
                return
            }
            items[index].name = file.displayName
            items[index].totalBytes = file.size
            items[index].state = .uploading
            let itemID = items[index].id
            let result: Result<UploadedMedia, MediaUploadError>
            do {
                let coordinator = self
                result = .success(try await uploader.upload(file) { sent in
                    Task { @MainActor in coordinator.progress(itemID, sent) }
                })
            } catch {
                result = .failure(error)
            }
            // The staged copy has done its job, whichever way the upload ended.
            try? FileManager.default.removeItem(at: file.url)
            guard generation == self.generation else { return }
            switch result {
            case .success(let uploaded):
                items[index].sentBytes = file.size
                items[index].isUploaded = true
                items[index].state = uploaded.assetID == nil ? .completed : .processing(fraction: nil)
                if let assetID = uploaded.assetID { mediaIDs[index] = assetID }
            case .failure(let error):
                items[index].state = error == .cancelled ? .cancelled : .failed(error)
            }
        }
        guard generation == self.generation else { return }
        removeStaging()
        conclude(outcomeIfNothingUploaded: userCancelled ? .cancelled : .failed)
        await followProcessing(mediaIDs, uploader: uploader, generation: generation)
    }

    private func progress(_ id: UUID, _ sent: Int64) {
        guard let index = items.firstIndex(where: { $0.id == id }), items[index].state == .uploading else { return }
        items[index].sentBytes = sent
    }

    /// Shows how the server is processing what it accepted, until it settles.
    /// This is display only: the intake already ended, and Studio owns the
    /// library. Any unreadable status settles the item as uploaded.
    private func followProcessing(_ mediaIDs: [Int: UUID], uploader: MediaUploader, generation: Int) async {
        var pending = mediaIDs
        var polls = 0
        while !pending.isEmpty, polls < maximumPolls, !Task.isCancelled, phase == .finished, generation == self.generation {
            try? await Task.sleep(for: pollInterval)
            for (index, assetID) in pending {
                let state = await uploader.processingState(of: assetID)
                guard generation == self.generation, index < items.count else { return }
                switch state {
                case .processing(let fraction): items[index].state = .processing(fraction: fraction)
                case .ready, .unknown:
                    items[index].state = .completed
                    pending[index] = nil
                case .failed:
                    items[index].state = .failed(.processingFailed)
                    pending[index] = nil
                }
            }
            polls += 1
        }
        guard generation == self.generation else { return }
        for index in pending.keys where index < items.count && !items[index].state.isSettled { items[index].state = .completed }
    }

    /// Tells Studio how the intake ended, once, and moves the sheet to its
    /// finished state.
    private func conclude(outcomeIfNothingUploaded: MediaIntakeOutcome) {
        guard let request else { return }
        let uploaded = items.filter(\.isUploaded).count
        let outcome: MediaIntakeOutcome
        if uploaded == 0 {
            outcome = outcomeIfNothingUploaded
        } else if uploaded == items.count {
            outcome = .completed
        } else {
            outcome = .partial
        }
        let report = report
        Task { await report(request.requestID, outcome, uploaded) }
        if items.isEmpty {
            // The picker ended with no selection: there is no sheet to keep.
            reset()
        } else {
            phase = .finished
        }
    }

    // MARK: Ending

    /// Cancel while files are transferring. What already reached the server
    /// stays there; the session in flight is cancelled.
    public func cancel() {
        guard phase == .transferring else { return }
        userCancelled = true
        transfer?.cancel()
    }

    /// The person is done with the sheet. Anything still transferring is
    /// cancelled first, and every temporary file is removed.
    public func dismiss() {
        switch phase {
        case .idle: break
        case .choosing: pickerCancelled()
        case .transferring:
            // Concluding happens when the cancelled transfer unwinds; the
            // sheet closes at once, and the state is cleared below.
            userCancelled = true
            transfer?.cancel()
            reset(concludingFirst: true)
        case .finished: reset()
        }
    }

    private func reset(concludingFirst: Bool = false) {
        if concludingFirst, let request {
            let uploaded = items.filter(\.isUploaded).count
            let report = report
            let outcome: MediaIntakeOutcome = uploaded == 0 ? .cancelled : (uploaded == items.count ? .completed : .partial)
            Task { await report(request.requestID, outcome, uploaded) }
        }
        generation += 1
        transfer?.cancel()
        transfer = nil
        removeStaging()
        request = nil
        items = []
        phase = .idle
        userCancelled = false
    }

    private func removeStaging() {
        if let directory { staging.remove(directory) }
        directory = nil
    }
}
