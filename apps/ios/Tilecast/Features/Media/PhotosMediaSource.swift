import CoreTransferable
import PhotosUI
import SwiftUI
import TilecastCore
import UniformTypeIdentifiers

/// A photo or video from `PhotosPicker`.
///
/// The picker runs out of process and hands back items without any
/// Photos-library permission. `loadTransferable` copies the chosen item to a
/// file, in the encoding the picker was asked for (`.compatible`, which
/// gives JPEG rather than HEIC), and this source moves that file into the
/// intake's temporary directory. The app never reads the Photos library.
struct PhotosMediaSource: MediaIntakeSource {
    let item: PhotosPickerItem

    func materialize(into directory: URL, staging: MediaStaging) async throws -> MediaIntakeFile {
        guard let picked = try await item.loadTransferable(type: PickedMedia.self) else {
            throw CocoaError(.fileReadUnknown)
        }
        // The transfer wrote into an inbox of its own; move the file in and
        // remove the inbox whichever way this ends.
        let inbox = picked.url.deletingLastPathComponent()
        defer { staging.removeInbox(inbox) }
        let staged = directory.appending(path: picked.url.lastPathComponent, directoryHint: .notDirectory)
        try FileManager.default.moveItem(at: picked.url, to: staged)
        return try staging.describe(staged, displayName: picked.name)
    }
}

/// A file the system wrote for a picked item, before it is moved into an
/// intake's directory. The transfer runs where no context reaches it, so the
/// file goes to an inbox below the fixed staging root.
struct PickedMedia: Transferable {
    let url: URL
    let name: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { try receive($0) }
        FileRepresentation(importedContentType: .movie) { try receive($0) }
    }

    private static func receive(_ received: ReceivedTransferredFile) throws -> PickedMedia {
        let inbox = try MediaStaging().makeInbox()
        let ext = received.file.pathExtension
        let url = inbox.appending(path: UUID().uuidString + (ext.isEmpty ? "" : ".\(ext)"), directoryHint: .notDirectory)
        // The system deletes its file when this closure returns, so copy it.
        try FileManager.default.copyItem(at: received.file, to: url)
        return PickedMedia(url: url, name: received.file.lastPathComponent)
    }
}
