import PhotosUI
import TilecastCore
import UIKit
import UniformTypeIdentifiers

/// Chooses files for a web `<input type="file">`, with the system's own
/// pickers: an action sheet for the source, then the Photos picker or the
/// document picker.
///
/// WebKit gives a page no file chooser of its own, and a page can accept
/// any file type, so the sheet offers both sources. The Photos picker runs
/// out of process and needs no Photos permission. Chosen files are copied
/// to temporary space under names the app generates, and the picked name
/// is metadata only. The system sweeps the temporary directory, and the app
/// removes leftovers at launch.
@MainActor
enum SystemFileInputPicker {
    private static var isPresenting = false

    /// The chosen files, or nil when the person cancels or nothing can be
    /// presented.
    static func choose(allowsMultiple: Bool) async -> [URL]? {
        guard !isPresenting, let presenter = TopViewController.find() else { return nil }
        isPresenting = true
        defer { isPresenting = false }
        guard let source = await chooseSource(from: presenter) else { return nil }
        // The action sheet must be gone before the next presentation.
        guard let presenter = TopViewController.find() else { return nil }
        switch source {
        case .photos: return await pickPhotos(allowsMultiple: allowsMultiple, from: presenter)
        case .files: return await pickDocuments(allowsMultiple: allowsMultiple, from: presenter)
        }
    }

    private enum Source { case photos, files }

    private static func chooseSource(from presenter: UIViewController) async -> Source? {
        await withCheckedContinuation { continuation in
            let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
            sheet.addAction(UIAlertAction(title: String(localized: "Photo Library"), style: .default) { _ in continuation.resume(returning: .photos) })
            sheet.addAction(UIAlertAction(title: String(localized: "Choose Files…"), style: .default) { _ in continuation.resume(returning: .files) })
            sheet.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel) { _ in continuation.resume(returning: nil) })
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            presenter.present(sheet, animated: true)
        }
    }

    // MARK: Files

    private static func pickDocuments(allowsMultiple: Bool, from presenter: UIViewController) async -> [URL]? {
        await withCheckedContinuation { continuation in
            // `asCopy` hands back copies in temporary space, so the page needs no
            // security-scoped access.
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = allowsMultiple
            let delegate = DocumentDelegate { urls in continuation.resume(returning: urls) }
            picker.delegate = delegate
            // The picker holds its delegate weakly.
            objc_setAssociatedObject(picker, &delegateKey, delegate, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            presenter.present(picker, animated: true)
        }
    }

    private final class DocumentDelegate: NSObject, UIDocumentPickerDelegate {
        let finish: ([URL]?) -> Void
        init(finish: @escaping ([URL]?) -> Void) { self.finish = finish }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            finish(urls.isEmpty ? nil : urls)
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            finish(nil)
        }
    }

    // MARK: Photos

    private static func pickPhotos(allowsMultiple: Bool, from presenter: UIViewController) async -> [URL]? {
        var configuration = PHPickerConfiguration()
        configuration.selectionLimit = allowsMultiple ? 0 : 1
        configuration.filter = .any(of: [.images, .videos])
        configuration.preferredAssetRepresentationMode = .compatible
        let results: [PHPickerResult] = await withCheckedContinuation { (continuation: CheckedContinuation<PickerResults, Never>) in
            let picker = PHPickerViewController(configuration: configuration)
            let delegate = PhotosDelegate { continuation.resume(returning: PickerResults(value: $0)) }
            picker.delegate = delegate
            objc_setAssociatedObject(picker, &delegateKey, delegate, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            presenter.present(picker, animated: true)
        }.value
        guard !results.isEmpty else { return nil }
        var urls: [URL] = []
        for result in results {
            if let url = await copy(result.itemProvider) { urls.append(url) }
        }
        return urls.isEmpty ? nil : urls
    }

    /// The picker hands its results back on the main actor and they go
    /// straight to the same actor's continuation, so the box is safe.
    private struct PickerResults: @unchecked Sendable { let value: [PHPickerResult] }

    private final class PhotosDelegate: NSObject, PHPickerViewControllerDelegate {
        let finish: ([PHPickerResult]) -> Void
        init(finish: @escaping ([PHPickerResult]) -> Void) { self.finish = finish }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            finish(results)
        }
    }

    /// Copies a picked item to temporary space. The system deletes its own
    /// file when the completion handler returns.
    private static func copy(_ provider: NSItemProvider) async -> URL? {
        guard let type = provider.registeredContentTypes.first(where: { $0.conforms(to: .image) || $0.conforms(to: .movie) }) else { return nil }
        let inbox = try? MediaStaging().makeInbox()
        guard let inbox else { return nil }
        let suggested = MediaStaging.displayName(provider.suggestedName ?? "Media")
        let name = (suggested as NSString).pathExtension.isEmpty
            ? suggested + (type.preferredFilenameExtension.map { ".\($0)" } ?? "")
            : suggested
        return await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else { return continuation.resume(returning: nil) }
                let destination = inbox.appending(path: name, directoryHint: .notDirectory)
                do {
                    try FileManager.default.copyItem(at: url, to: destination)
                    continuation.resume(returning: destination)
                } catch {
                    continuation.resume(returning: nil)
                }
            }
        }
    }
}

nonisolated(unsafe) private var delegateKey = 0
