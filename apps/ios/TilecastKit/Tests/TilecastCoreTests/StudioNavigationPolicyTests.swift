import Foundation
import Testing
@testable import TilecastCore

@Suite struct StudioNavigationPolicyTests {
    let policy = StudioNavigationPolicy(origin: WebOrigin(URL(string: "https://signage.example.org")!)!)

    func main(_ url: String) -> StudioNavigationDecision {
        policy.decide(url: URL(string: url), isMainFrame: true, opensNewWindow: false, shouldDownload: false)
    }

    func newWindow(_ url: String) -> StudioNavigationDecision {
        policy.decide(url: URL(string: url), isMainFrame: true, opensNewWindow: true, shouldDownload: false)
    }

    func subframe(_ url: String) -> StudioNavigationDecision {
        policy.decide(url: URL(string: url), isMainFrame: false, opensNewWindow: false, shouldDownload: false)
    }

    @Test func keepsServerOriginInTheMainFrame() {
        #expect(main("https://signage.example.org/screens") == .allow)
        #expect(main("https://SIGNAGE.example.org:443/plugins/weather") == .allow)
        #expect(main("about:blank") == .allow)
    }

    @Test func sendsOtherSitesToTheSystem() {
        let external = URL(string: "https://docs.tilecast.org/")!
        #expect(main(external.absoluteString) == .openExternally(external))
        // Same host, different port or scheme, is a different origin.
        #expect(main("https://signage.example.org:8443/") == .openExternally(URL(string: "https://signage.example.org:8443/")!))
        #expect(main("http://signage.example.org/") == .openExternally(URL(string: "http://signage.example.org/")!))
        #expect(main("mailto:help@example.org") == .openExternally(URL(string: "mailto:help@example.org")!))
        #expect(main("tel:+15555550100") == .openExternally(URL(string: "tel:+15555550100")!))
    }

    @Test func refusesSchemesThatCouldTakeOverThePage() {
        for url in ["javascript:alert(1)", "file:///etc/hosts", "data:text/html,hi", "blob:https://signage.example.org/x", "tilecast://x", "about:srcdoc"] {
            #expect(main(url) == .cancel, "\(url)")
        }
        #expect(policy.decide(url: nil, isMainFrame: true, opensNewWindow: false, shouldDownload: false) == .cancel)
    }

    @Test func routesNewWindowRequests() {
        let snapshot = URL(string: "https://signage.example.org/api/v1/snapshots/1/image")!
        #expect(newWindow(snapshot.absoluteString) == .openAuxiliary(snapshot))
        let github = URL(string: "https://github.com/settings/applications/new")!
        #expect(newWindow(github.absoluteString) == .openExternally(github))
        #expect(newWindow("javascript:void(0)") == .cancel)
    }

    @Test func letsSubframesFollowStudioContentSecurityPolicy() {
        #expect(subframe("https://www.youtube-nocookie.com/embed/x") == .allow)
        #expect(subframe("about:srcdoc") == .allow)
        #expect(subframe("blob:https://signage.example.org/1") == .allow)
        #expect(subframe("file:///private/var/x") == .cancel)
        #expect(subframe("itms-apps://apps.apple.com") == .cancel)
    }

    @Test func refusesDownloads() {
        #expect(policy.decide(url: URL(string: "https://signage.example.org/export"), isMainFrame: true,
                              opensNewWindow: false, shouldDownload: true) == .unsupportedDownload)
        let url = URL(string: "https://signage.example.org/api/v1/settings/export")!
        let attachment = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                                         headerFields: ["Content-Disposition": "Attachment; filename=x.json"])!
        #expect(policy.decide(response: attachment, canShowMIMEType: true) == .unsupportedDownload)
        let inline = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: [:])!
        #expect(policy.decide(response: inline, canShowMIMEType: true) == .allow)
        #expect(policy.decide(response: inline, canShowMIMEType: false) == .unsupportedDownload)
    }
}
