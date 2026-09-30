import Foundation
import UniformTypeIdentifiers

/// A picked file, copied into the app's temporary space so a resumable
/// upload can read it again after a network failure.
public struct MediaIntakeFile: Equatable, Sendable {
    /// The name people see: the picked file's name, or a generic one. It is
    /// upload metadata only and never a path.
    public var displayName: String
    /// Where the staged copy is. Its name is generated, not the picked name.
    public var url: URL
    public var size: Int64
    public var mimeType: String

    public init(displayName: String, url: URL, size: Int64, mimeType: String) {
        self.displayName = displayName
        self.url = url
        self.size = size
        self.mimeType = mimeType
    }
}

/// Temporary storage for picked media.
///
/// Everything lives below one directory in the app's temporary space. Each
/// intake gets its own subdirectory with generated names, so a picked file
/// name is metadata and never a filesystem path. Nothing is kept in
/// app preferences, the Keychain, state restoration, or the bridge, and the
/// owner removes a directory after success, cancellation, definitive
/// failure, a server switch, and sign-out. A sweep at launch removes what an
/// ended app left behind.
public struct MediaStaging: Sendable {
    public let root: URL

    public init(root: URL = FileManager.default.temporaryDirectory.appending(path: "TilecastMediaIntake", directoryHint: .isDirectory)) {
        self.root = root
    }

    /// A new, empty directory for one intake.
    public func makeDirectory() throws -> URL {
        let directory = root.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    /// A directory for a file the system writes before an intake exists,
    /// for example a transfer from the Photos picker. The file is moved into
    /// an intake's directory afterwards.
    public func makeInbox() throws -> URL {
        let inbox = root.appending(path: "Inbox-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        return inbox
    }

    public func removeInbox(_ inbox: URL) {
        guard inbox.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL,
              inbox.lastPathComponent.hasPrefix("Inbox-") else { return }
        try? FileManager.default.removeItem(at: inbox)
    }

    public func remove(_ directory: URL) {
        // Only ever a directory this staging made.
        guard directory.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL else { return }
        try? FileManager.default.removeItem(at: directory)
    }

    /// Removes every intake directory. Call when no intake can be running.
    public func sweep() {
        try? FileManager.default.removeItem(at: root)
    }

    /// Copies `source` into `directory` under a generated name and describes
    /// the copy. The caller owns access to `source` while this runs.
    public func stage(copyOf source: URL, displayName: String?, in directory: URL) throws -> MediaIntakeFile {
        let name = Self.displayName(displayName ?? source.lastPathComponent)
        let ext = Self.fileExtension(of: name)
        let staged = directory.appending(path: UUID().uuidString + (ext.isEmpty ? "" : ".\(ext)"), directoryHint: .notDirectory)
        try FileManager.default.copyItem(at: source, to: staged)
        return try describe(staged, displayName: name)
    }

    /// Describes a file that is already in `directory`, for example one a
    /// system transfer wrote there.
    public func describe(_ staged: URL, displayName: String) throws -> MediaIntakeFile {
        let size = try FileManager.default.attributesOfItem(atPath: staged.path)[.size] as? Int64 ?? 0
        return MediaIntakeFile(
            displayName: displayName,
            url: staged,
            size: size,
            mimeType: Self.mimeType(forFileNamed: displayName, fallbackURL: staged)
        )
    }

    // MARK: Names and types

    /// A name safe to show and to send as upload metadata: no path
    /// components, no control characters, at most 255 characters.
    public static func displayName(_ value: String) -> String {
        var name = value.replacingOccurrences(of: "\\", with: "/")
        name = String(name.split(separator: "/", omittingEmptySubsequences: true).last ?? "")
        name = name.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F }.map(String.init).joined()
        name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty || name == "." || name == ".." { return "Media" }
        return String(name.prefix(255))
    }

    static func fileExtension(of name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        // A short alphanumeric extension only, so the extension is never a path.
        return ext.count <= 8 && ext.allSatisfy { $0.isLetter || $0.isNumber } ? ext : ""
    }

    /// The MIME type for an upload: from the name's extension, then from the
    /// staged file's, then the generic type the server inspects anyway.
    static func mimeType(forFileNamed name: String, fallbackURL: URL) -> String {
        for ext in [fileExtension(of: name), fallbackURL.pathExtension.lowercased()] where !ext.isEmpty {
            if let type = UTType(filenameExtension: ext)?.preferredMIMEType { return type }
        }
        return "application/octet-stream"
    }
}

/// Where a picked item comes from. A source copies its content into staging
/// on demand, so the picker result stays small until the upload starts.
public protocol MediaIntakeSource: Sendable {
    func materialize(into directory: URL, staging: MediaStaging) async throws -> MediaIntakeFile
}

/// A file from the Files picker. The picker hands out a security-scoped URL:
/// access is opened for the copy only and released when it ends.
public struct FileImportSource: MediaIntakeSource {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    public func materialize(into directory: URL, staging: MediaStaging) async throws -> MediaIntakeFile {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try await Task.detached(priority: .userInitiated) {
            // A coordinated read also downloads an iCloud Drive file that is not on the device.
            var coordinationError: NSError?
            var result: Result<MediaIntakeFile, any Error> = .failure(CocoaError(.fileReadUnknown))
            NSFileCoordinator().coordinate(readingItemAt: url, options: [.withoutChanges], error: &coordinationError) { readable in
                result = Result { try staging.stage(copyOf: readable, displayName: url.lastPathComponent, in: directory) }
            }
            if let coordinationError { throw coordinationError }
            return try result.get()
        }.value
    }
}
