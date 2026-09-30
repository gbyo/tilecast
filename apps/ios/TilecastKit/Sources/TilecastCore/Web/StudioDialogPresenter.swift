import Foundation
import WebKit

/// Answers the dialogs a Studio page opens, for the one that needs the app:
/// the file chooser of `<input type="file">`.
///
/// A `WebPage` with no dialog presenter cancels every file chooser, so a
/// Studio upload button would do nothing. The app chooses the files with
/// system pickers, and WebKit gives the page access to exactly those files.
/// Studio decides what to do with them, as it does in a browser.
///
/// Only a frame of the server's own origin may open a chooser. JavaScript
/// alerts, confirmations, and prompts keep WebKit's defaults: Studio shows
/// its own, or a native alert through the bridge.
struct StudioDialogPresenter: WebPage.DialogPresenting {
    let origin: WebOrigin
    let system: SystemIntegrationHandlers

    @MainActor
    func handleFileInputPrompt(
        parameters: WKOpenPanelParameters,
        initiatedBy frame: WebPage.FrameInfo
    ) async -> WebPage.FileInputPromptResult {
        let security = frame.securityOrigin
        guard WebOrigin(scheme: security.protocol, host: security.host, port: security.port) == origin,
              let urls = await system.chooseFiles?(parameters.allowsMultipleSelection), !urls.isEmpty else {
            return .cancel
        }
        return .selected(urls)
    }
}
