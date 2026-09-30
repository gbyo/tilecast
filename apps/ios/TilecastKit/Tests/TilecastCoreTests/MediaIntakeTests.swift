import Foundation
import Testing
@testable import TilecastCore

/// A picked item that writes its bytes into staging when it is materialized.
struct FixtureSource: MediaIntakeSource {
    var name: String
    var bytes = Data("0123456789".utf8)
    var fails = false
    /// Suspends materialization until opened.
    var gate: Gate?

    func materialize(into directory: URL, staging: MediaStaging) async throws -> MediaIntakeFile {
        if let gate { await gate.wait() }
        if fails { throw CocoaError(.fileReadNoSuchFile) }
        let url = directory.appending(path: UUID().uuidString)
        try bytes.write(to: url)
        return try staging.describe(url, displayName: name)
    }
}

@MainActor
func waitUntil(_ timeout: Duration = .seconds(5), _ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while !condition() {
        if ContinuousClock.now > deadline { return false }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return true
}

func stagedEntries(_ staging: MediaStaging) -> [String] {
    var entries: [String] = []
    if let enumerator = FileManager.default.enumerator(atPath: staging.root.path) {
        for case let path as String in enumerator {
            var isDirectory: ObjCBool = false
            FileManager.default.fileExists(atPath: staging.root.appending(path: path).path, isDirectory: &isDirectory)
            if !isDirectory.boolValue { entries.append(path) }
        }
    }
    return entries
}

struct Report: Equatable {
    var requestID: String
    var outcome: MediaIntakeOutcome
    var count: Int
}

extension StubbedHTTPTests {
    @MainActor
    @Suite struct MediaIntakeCoordinatorTests {
        let sessionServer = FakeSessionServer()
        let store = InMemoryCredentialStore()
        let upload = FakeUploadServer()
        let staging = MediaStaging(root: FileManager.default.temporaryDirectory.appending(path: "TilecastIntakeTests-\(UUID().uuidString)", directoryHint: .isDirectory))
        let bridge = StudioBridge(origin: serverOrigin)
        let coordinator: MediaIntakeCoordinator
        let auth: NativeAuthSession
        let reports = Locked<[Report]>([])

        init() async throws {
            StubProtocol.reset()
            let upload = upload
            StubProtocol.handler = { upload.handle($0) }
            auth = NativeAuthSession(
                key: NativeCredentialKey(serverID: UUID(), installationID: UUID()),
                address: address("signage.example.org"), exchanger: sessionServer, store: store
            )
            _ = try await auth.completeSignIn(code: "c", verifier: "v")
            coordinator = MediaIntakeCoordinator(staging: staging, pollInterval: .milliseconds(5), maximumPolls: 20) { session in
                MediaUploader(client: session.makeClient(transport: stubTransport()), chunkSize: 4, retry: .immediate)
            }
            coordinator.attach(bridge: bridge, auth: auth)
            let reports = reports
            coordinator.report = { id, outcome, count in reports.mutate { $0.append(Report(requestID: id, outcome: outcome, count: count)) } }
        }

        func request(_ id: String = "mi-1") -> MediaIntakeRequest { MediaIntakeRequest(requestID: id) }

        // MARK: Starting

        @Test func startsOnlyWithANativeCredential() async throws {
            #expect(coordinator.canBegin)
            let older = MediaIntakeCoordinator(staging: staging)
            older.attach(bridge: StudioBridge(origin: serverOrigin), auth: NativeAuthSession(
                key: NativeCredentialKey(serverID: UUID(), installationID: UUID()),
                address: address("signage.example.org"), exchanger: sessionServer, store: InMemoryCredentialStore()
            ))
            #expect(!older.canBegin, "a server without native API access keeps Studio's uploader")
            #expect(older.begin(request()) == false)
            #expect(older.phase == .idle)
        }

        @Test func theBridgeSaysUnavailableWithoutACredentialAndAvailableWithOne() async throws {
            _ = bridge.replyValue(to: envelope("config/get"), from: .studio)
            _ = bridge.replyValue(to: envelope("frontend/ready", ["capabilities": ["nativeMediaIntake": true]]), from: .studio)
            let status = bridge.replyValue(to: envelope("system/media-intake-status", id: "m1"), from: .studio)
            #expect(status == NativeBridgeProtocol.reply(id: "m1", payload: ["available": .bool(true)]))

            let older = StudioBridge(origin: serverOrigin)
            let coordinator = MediaIntakeCoordinator(staging: staging)
            coordinator.attach(bridge: older, auth: NativeAuthSession(
                key: NativeCredentialKey(serverID: UUID(), installationID: UUID()),
                address: address("signage.example.org"), exchanger: sessionServer, store: InMemoryCredentialStore()
            ))
            _ = older.replyValue(to: envelope("config/get"), from: .studio)
            _ = older.replyValue(to: envelope("frontend/ready", ["capabilities": ["nativeMediaIntake": true]]), from: .studio)
            #expect(older.replyValue(to: envelope("system/media-intake-status", id: "m1"), from: .studio)
                == NativeBridgeProtocol.reply(id: "m1", payload: ["available": .bool(false)]))
            #expect(older.replyValue(to: envelope("system/media-intake", ["requestId": "mi-1"]), from: .studio)
                == NativeBridgeProtocol.reply(id: nil, error: .unavailable), "Studio falls back to its own uploader")
        }

        @Test func refusesASecondIntakeWhileOneIsActive() {
            #expect(coordinator.begin(request()))
            #expect(coordinator.phase == .choosing)
            #expect(coordinator.begin(request("mi-2")) == false)
            #expect(bridge.isMediaIntakeAvailable?() == false)
        }

        // MARK: Transfer

        @Test func uploadsWhatWasChosenAndTellsStudioOnce() async throws {
            #expect(coordinator.begin(request()))
            coordinator.startTransfer([FixtureSource(name: "one.jpg"), FixtureSource(name: "two.mov")])
            #expect(coordinator.phase == .transferring)
            #expect(await waitUntil { coordinator.phase == .finished })

            #expect(coordinator.items.map(\.isUploaded) == [true, true])
            #expect(coordinator.items.map(\.name) == ["one.jpg", "two.mov"])
            #expect(upload.completedCount == 2)
            #expect(upload.sessionCount == 2)
            #expect(await waitUntil { reports.value.count == 1 })
            #expect(reports.value == [Report(requestID: "mi-1", outcome: .completed, count: 2)])
            #expect(stagedEntries(staging).isEmpty, "no temporary copy outlives the upload")
            // The library is Studio's. Native code only shows the server's processing state.
            #expect(await waitUntil { coordinator.items.allSatisfy { $0.state == .completed } })
        }

        @Test func aFailedItemDoesNotStopTheOthers() async throws {
            #expect(coordinator.begin(request()))
            coordinator.startTransfer([FixtureSource(name: "bad.jpg", fails: true), FixtureSource(name: "good.jpg")])
            #expect(await waitUntil { coordinator.phase == .finished })
            #expect(coordinator.items[0].state == .failed(.unreadable))
            #expect(coordinator.items[1].isUploaded)
            #expect(await waitUntil { reports.value.count == 1 })
            #expect(reports.value == [Report(requestID: "mi-1", outcome: .partial, count: 1)])
            #expect(stagedEntries(staging).isEmpty)
        }

        @Test func reportsFailedWhenNothingUploaded() async throws {
            upload.failCreate(413)
            #expect(coordinator.begin(request()))
            coordinator.startTransfer([FixtureSource(name: "big.mov")])
            #expect(await waitUntil { coordinator.phase == .finished })
            #expect(coordinator.items[0].state == .failed(.tooLarge))
            #expect(await waitUntil { reports.value.count == 1 })
            #expect(reports.value == [Report(requestID: "mi-1", outcome: .failed, count: 0)])
            #expect(stagedEntries(staging).isEmpty, "a definitive failure removes the copy")
        }

        @Test func showsProcessingUntilTheServerIsDone() async throws {
            upload.processing("processing", "processing", "ready")
            #expect(coordinator.begin(request()))
            coordinator.startTransfer([FixtureSource(name: "one.jpg")])
            #expect(await waitUntil { coordinator.phase == .finished })
            #expect(await waitUntil { coordinator.items[0].state == .completed })
        }

        @Test func aFailedProcessingShowsAsFailedButTheUploadStillCounts() async throws {
            upload.processing("failed")
            #expect(coordinator.begin(request()))
            coordinator.startTransfer([FixtureSource(name: "one.jpg")])
            #expect(await waitUntil { coordinator.items.first?.state == .failed(.processingFailed) })
            #expect(coordinator.items[0].isUploaded)
            #expect(reports.value == [Report(requestID: "mi-1", outcome: .completed, count: 1)])
        }

        // MARK: Ending early

        @Test func cancellingKeepsWhatArrivedCancelsTheRestAndCleansUp() async throws {
            let gate = Gate()
            #expect(coordinator.begin(request()))
            coordinator.startTransfer([FixtureSource(name: "one.jpg"), FixtureSource(name: "two.jpg", gate: gate)])
            #expect(await waitUntil { coordinator.items[0].isUploaded })
            coordinator.cancel()
            gate.open()
            #expect(await waitUntil { coordinator.phase == .finished })
            #expect(coordinator.items[1].state == .cancelled)
            #expect(await waitUntil { reports.value.count == 1 })
            #expect(reports.value == [Report(requestID: "mi-1", outcome: .partial, count: 1)])
            #expect(stagedEntries(staging).isEmpty)
        }

        @Test func cancellingBeforeAnythingUploadedReportsCancelled() async throws {
            let gate = Gate()
            #expect(coordinator.begin(request()))
            coordinator.startTransfer([FixtureSource(name: "one.jpg", gate: gate)])
            coordinator.cancel()
            gate.open()
            #expect(await waitUntil { coordinator.phase == .finished })
            #expect(await waitUntil { reports.value.count == 1 })
            #expect(reports.value == [Report(requestID: "mi-1", outcome: .cancelled, count: 0)])
            #expect(stagedEntries(staging).isEmpty)
        }

        @Test func closingTheSheetMidTransferEndsItOnceAndCleansUp() async throws {
            let gate = Gate()
            #expect(coordinator.begin(request()))
            coordinator.startTransfer([FixtureSource(name: "one.jpg"), FixtureSource(name: "two.jpg", gate: gate)])
            #expect(await waitUntil { coordinator.items[0].isUploaded })
            coordinator.dismiss()
            #expect(coordinator.phase == .idle)
            #expect(coordinator.items.isEmpty)
            gate.open()
            try await Task.sleep(for: .milliseconds(200))
            #expect(reports.value == [Report(requestID: "mi-1", outcome: .partial, count: 1)], "the unwinding transfer reports nothing more")
            #expect(coordinator.phase == .idle)
            #expect(stagedEntries(staging).isEmpty, "the copy of the second file was removed too")
            #expect(coordinator.canBegin, "the next intake can start at once")
        }

        @Test func closingThePickerReportsCancelled() async throws {
            #expect(coordinator.begin(request()))
            coordinator.pickerCancelled()
            #expect(coordinator.phase == .idle)
            #expect(await waitUntil { reports.value.count == 1 })
            #expect(reports.value == [Report(requestID: "mi-1", outcome: .cancelled, count: 0)])
        }

        @Test func anEmptySelectionIsACancellation() async throws {
            #expect(coordinator.begin(request()))
            coordinator.startTransfer([])
            #expect(coordinator.phase == .idle)
            #expect(await waitUntil { reports.value.count == 1 })
            #expect(reports.value.first?.outcome == .cancelled)
        }

        @Test func aPickerFailureReportsFailed() async throws {
            #expect(coordinator.begin(request()))
            coordinator.pickerFailed()
            #expect(await waitUntil { reports.value.count == 1 })
            #expect(reports.value == [Report(requestID: "mi-1", outcome: .failed, count: 0)])
        }

        @Test func aServerSwitchEndsTheIntakeWithoutAWordAndCleansUp() async throws {
            let gate = Gate()
            #expect(coordinator.begin(request()))
            coordinator.startTransfer([FixtureSource(name: "one.jpg"), FixtureSource(name: "two.jpg", gate: gate)])
            #expect(await waitUntil { coordinator.items[0].isUploaded })
            coordinator.detach()
            gate.open()
            try await Task.sleep(for: .milliseconds(150))
            #expect(coordinator.phase == .idle)
            #expect(reports.value.isEmpty, "the page that asked belonged to the server that was left")
            #expect(stagedEntries(staging).isEmpty)
            #expect(!coordinator.canBegin, "nothing is attached to any server now")
        }

        @Test func signingOutEndsTheIntakeButStaysAttachedForTheNextSignIn() async throws {
            let gate = Gate()
            #expect(coordinator.begin(request()))
            coordinator.startTransfer([FixtureSource(name: "one.jpg", gate: gate)])
            coordinator.cancelActive()
            gate.open()
            try await Task.sleep(for: .milliseconds(150))
            #expect(coordinator.phase == .idle)
            #expect(stagedEntries(staging).isEmpty)
            #expect(coordinator.canBegin)
        }

        @Test func sweepsWhatAnEndedAppLeftBehind() throws {
            let directory = try staging.makeDirectory()
            try Data("x".utf8).write(to: directory.appending(path: "left-over"))
            #expect(stagedEntries(staging).count == 1)
            coordinator.sweepStaging()
            #expect(stagedEntries(staging).isEmpty)
        }
    }
}

@Suite struct MediaStagingTests {
    let staging = MediaStaging(root: FileManager.default.temporaryDirectory.appending(path: "TilecastStagingTests-\(UUID().uuidString)", directoryHint: .isDirectory))

    @Test(arguments: [
        ("IMG_0001.HEIC", "IMG_0001.HEIC"),
        ("../../etc/passwd", "passwd"),
        ("..\\..\\windows\\system32", "system32"),
        ("/var/mobile/photo.jpg", "photo.jpg"),
        ("line\nbreak\u{0}.jpg", "linebreak.jpg"),
        ("   ", "Media"),
        ("..", "Media"),
        ("", "Media"),
    ])
    func aPickedNameIsNeverAPath(_ picked: String, _ expected: String) {
        #expect(MediaStaging.displayName(picked) == expected)
    }

    @Test func boundsTheNameAtTheServersLimit() {
        #expect(MediaStaging.displayName(String(repeating: "a", count: 400)).count == 255)
    }

    @Test func stagesACopyUnderAGeneratedNameAndLeavesTheOriginal() throws {
        let directory = try staging.makeDirectory()
        defer { staging.sweep() }
        let original = FileManager.default.temporaryDirectory.appending(path: "picked-\(UUID().uuidString).mov")
        try Data("video".utf8).write(to: original)
        defer { try? FileManager.default.removeItem(at: original) }

        let file = try staging.stage(copyOf: original, displayName: "../Holiday.MOV", in: directory)

        #expect(file.displayName == "Holiday.MOV")
        #expect(file.url.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL)
        #expect(!file.url.lastPathComponent.contains("Holiday"), "the picked name is metadata, never a path")
        #expect(file.url.pathExtension == "mov")
        #expect(file.size == 5)
        #expect(file.mimeType == "video/quicktime")
        #expect(FileManager.default.fileExists(atPath: original.path), "the person's file is untouched")
    }

    @Test func infersMediaTypesAndFallsBackToTheGenericType() {
        #expect(MediaStaging.mimeType(forFileNamed: "a.JPG", fallbackURL: URL(filePath: "/x")) == "image/jpeg")
        #expect(MediaStaging.mimeType(forFileNamed: "a.png", fallbackURL: URL(filePath: "/x")) == "image/png")
        #expect(MediaStaging.mimeType(forFileNamed: "a.mp4", fallbackURL: URL(filePath: "/x")) == "video/mp4")
        #expect(MediaStaging.mimeType(forFileNamed: "noextension", fallbackURL: URL(filePath: "/x")) == "application/octet-stream")
        #expect(MediaStaging.mimeType(forFileNamed: "a.zzzzzz-not-a-type", fallbackURL: URL(filePath: "/x")) == "application/octet-stream")
    }

    @Test func aFileImportCopiesAndReleasesAccess() async throws {
        let directory = try staging.makeDirectory()
        defer { staging.sweep() }
        let original = FileManager.default.temporaryDirectory.appending(path: "Files pick \(UUID().uuidString).jpg")
        try Data("image".utf8).write(to: original)
        defer { try? FileManager.default.removeItem(at: original) }

        let file = try await FileImportSource(url: original).materialize(into: directory, staging: staging)

        #expect(file.displayName == original.lastPathComponent)
        #expect(try Data(contentsOf: file.url) == Data("image".utf8))
        #expect(file.url != original)
        #expect(file.mimeType == "image/jpeg")
    }

    @Test func removesOnlyItsOwnDirectories() throws {
        let foreign = FileManager.default.temporaryDirectory.appending(path: "Foreign-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: foreign, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: foreign) }
        staging.remove(foreign)
        #expect(FileManager.default.fileExists(atPath: foreign.path), "a directory this staging did not make is never deleted")
    }
}

/// The host owns the coordinator's lifetime: an intake belongs to one
/// server and one signed-in session.
@MainActor
@Suite struct MediaIntakeHostTests {
    let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
    let stores = FakeDataStores()
    let client = FakeIdentityClient()
    let credentials = InMemoryCredentialStore()
    let staging = MediaStaging(root: FileManager.default.temporaryDirectory.appending(path: "TilecastHostIntakeTests-\(UUID().uuidString)", directoryHint: .isDirectory))

    func makeHost() -> StudioHost {
        StudioHost(
            directory: directory, dataStores: stores, identityClient: client, credentials: credentials,
            applicationName: "TilecastTests", mediaIntake: MediaIntakeCoordinator(staging: staging)
        )
    }

    func addServer(_ host: String, name: String, signedIn: Bool) throws -> ServerProfile {
        let identity = identity(name)
        let profile = try directory.add(address: address(host), identity: identity)
        client.answers[profile.address.description] = .success(identity)
        if signedIn { try credentials.setRefreshToken("tcr_refresh", for: NativeCredentialKey(profile: profile)) }
        return profile
    }

    @Test func aServerWithoutNativeAccessKeepsStudiosUploader() async throws {
        let older = try addServer("old.example.org", name: "Old", signedIn: false)
        let host = makeHost()
        await host.activate(older.id)
        #expect(host.mediaIntake.canBegin == false)
        host.page?.close()
    }

    @Test func switchingServersEndsTheIntakeAndRemovesItsFiles() async throws {
        let a = try addServer("a.example.org", name: "A", signedIn: true)
        let b = try addServer("b.example.org", name: "B", signedIn: true)
        let host = makeHost()
        await host.activate(a.id)
        #expect(host.mediaIntake.canBegin)
        let gate = Gate()
        #expect(host.mediaIntake.begin(MediaIntakeRequest(requestID: "mi-1")))
        host.mediaIntake.startTransfer([FixtureSource(name: "one.jpg", gate: gate)])
        #expect(host.mediaIntake.phase == .transferring)

        await host.activate(b.id)
        gate.open()
        try await Task.sleep(for: .milliseconds(150))
        #expect(host.mediaIntake.phase == .idle)
        #expect(stagedEntries(staging).isEmpty)
        #expect(host.mediaIntake.canBegin, "the new server has its own credential")
        host.page?.close()
    }

    @Test func signingOutEndsTheIntakeAndRemovesItsFiles() async throws {
        let a = try addServer("a.example.org", name: "A", signedIn: true)
        let host = makeHost()
        await host.activate(a.id)
        let gate = Gate()
        #expect(host.mediaIntake.begin(MediaIntakeRequest(requestID: "mi-1")))
        host.mediaIntake.startTransfer([FixtureSource(name: "one.jpg", gate: gate)])

        await host.signOut()
        gate.open()
        try await Task.sleep(for: .milliseconds(150))
        #expect(host.mediaIntake.phase == .idle)
        #expect(stagedEntries(staging).isEmpty)
        #expect(host.mediaIntake.canBegin == false, "signing out deleted the native credential")
        host.page?.close()
    }

    @Test func removingTheServerEndsTheIntake() async throws {
        let a = try addServer("a.example.org", name: "A", signedIn: true)
        let host = makeHost()
        await host.activate(a.id)
        #expect(host.mediaIntake.begin(MediaIntakeRequest(requestID: "mi-1")))
        await host.remove(a.id)
        #expect(host.mediaIntake.phase == .idle)
        #expect(host.mediaIntake.canBegin == false)
    }
}
