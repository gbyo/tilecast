import LinkPresentation
import TilecastCore
import UIKit

/// Presents the system share sheet for `system/share`.
///
/// SwiftUI's `ShareLink` is the right tool when a share starts from a native
/// SwiftUI control, but it is a view: it cannot be presented from a bridge
/// message that arrives later. There is no imperative share API in SwiftUI,
/// so this adapter is the one place that reaches UIKit to present
/// `UIActivityViewController`. It presents from the top view controller, so
/// a share requested from inside a native presentation appears above that
/// sheet. It builds no share interface of its own.
///
/// The item carries a title, so the sheet shows a sensible preview. The
/// content was validated on the bridge: it holds no credential.
@MainActor
enum SystemSharePresenter {
    private static var isPresenting = false

    /// Presents the sheet. Returns false when it cannot: one is already up,
    /// or there is no window to present from.
    static func present(_ share: SystemShare) -> Bool {
        guard !isPresenting, let presenter = TopViewController.find() else { return false }
        var items: [Any] = []
        if let text = share.text { items.append(ShareItem(value: text, title: share.title, url: nil)) }
        if let url = share.url { items.append(ShareItem(value: url, title: share.title, url: url)) }
        guard !items.isEmpty else { return false }

        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let popover = controller.popoverPresentationController {
            // An iPad shows the sheet in a popover, which needs an anchor.
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        controller.completionWithItemsHandler = { _, _, _, _ in
            Task { @MainActor in isPresenting = false }
        }
        isPresenting = true
        presenter.present(controller, animated: true)
        return true
    }
}

/// One shared value, with the title the share sheet shows above it.
private final class ShareItem: NSObject, UIActivityItemSource {
    let value: Any
    let title: String?
    let url: URL?

    init(value: Any, title: String?, url: URL?) {
        self.value = value
        self.title = title
        self.url = url
    }

    func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController) -> Any {
        value
    }

    func activityViewController(_ activityViewController: UIActivityViewController, itemForActivityType activityType: UIActivity.ActivityType?) -> Any? {
        value
    }

    func activityViewController(_ activityViewController: UIActivityViewController, subjectForActivityType activityType: UIActivity.ActivityType?) -> String {
        title ?? ""
    }

    func activityViewControllerLinkMetadata(_ activityViewController: UIActivityViewController) -> LPLinkMetadata? {
        guard let url else { return nil }
        let metadata = LPLinkMetadata()
        metadata.originalURL = url
        metadata.url = url
        metadata.title = title
        return metadata
    }
}
