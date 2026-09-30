import ObjectiveC
import SwiftUI
import UIKit

/// Makes the container behind a `TabView`'s content transparent.
///
/// Studio's one web view is drawn behind the tabs, so the floating iOS 26
/// tab bar shows the page through its glass. SwiftUI's `TabView` is a
/// `UITabBarController`, and its container views paint an opaque background
/// that SwiftUI has no modifier to remove. This adapter is the one place that
/// reaches UIKit for it. It finds the tab bar controller from inside a tab's
/// content and clears the background color of the container views below it.
/// It never touches the tab bar.
///
/// The container views also swallow touches where they are transparent, so
/// the web view behind them would get none. The adapter gives the tab
/// controller's view a `hitTest` that keeps only hits on the tab bar and the
/// navigation bar while Studio shows. A touch anywhere else falls through to
/// the web view.
struct TransparentTabContainer: UIViewRepresentable {
    /// Studio's web view is showing behind the tabs. Only the tab bar and
    /// the navigation bar keep their touches then; the More list keeps all.
    var studioVisible: Bool

    func makeUIView(context: Context) -> Probe { Probe() }

    func updateUIView(_ view: Probe, context: Context) {
        view.studioVisible = studioVisible
        view.clearContainer()
    }

    final class Probe: UIView {
        var studioVisible = false

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            backgroundColor = .clear
        }

        required init?(coder: NSCoder) {
            fatalError("init(coder:) is not used")
        }

        // The responder chain is complete only after the view is in a
        // window and laid out, and SwiftUI may set a background again, so
        // clear on each of these.
        override func didMoveToWindow() {
            super.didMoveToWindow()
            clearContainer()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            clearContainer()
        }

        func clearContainer() {
            var responder: UIResponder? = self
            while let current = responder {
                if let controller = current as? UIViewController, let tabs = controller.tabBarController {
                    Self.clear(tabs.view, depth: 0)
                    // The tab controller's view, and every wrapper SwiftUI
                    // puts around it up to its hosting view, can swallow a
                    // touch that no content claims.
                    var wrapper: UIView? = tabs.view
                    while let view = wrapper, !NSStringFromClass(type(of: view)).contains("HostingView") {
                        PassthroughHitTest.install(on: view)
                        PassthroughHitTest.setStudioVisible(studioVisible, on: view)
                        wrapper = view.superview
                    }
                    return
                }
                responder = current.next
            }
        }

        private static func clear(_ view: UIView, depth: Int) {
            // Stop at the tab bar itself and at anything deep in a hierarchy.
            guard depth < 5, !(view is UITabBar) else { return }
            view.backgroundColor = .clear
            for subview in view.subviews { clear(subview, depth: depth + 1) }
        }
    }
}

/// Gives one view a `hitTest` that ignores its own empty containers.
///
/// The view's class is replaced, for that one instance, by a runtime
/// subclass that calls the original `hitTest` and then drops the result
/// unless it is on the tab bar or inside SwiftUI-hosted content.
private enum PassthroughHitTest {
    nonisolated(unsafe) private static var subclasses: [ObjectIdentifier: AnyClass] = [:]
    nonisolated(unsafe) private static var visibleKey = 0
    private static let prefix = "TilecastPassthrough_"

    static func setStudioVisible(_ visible: Bool, on view: UIView) {
        objc_setAssociatedObject(view, &visibleKey, NSNumber(value: visible), .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }

    @MainActor
    private static func studioVisible(on view: UIView) -> Bool {
        (objc_getAssociatedObject(view, &visibleKey) as? NSNumber)?.boolValue ?? false
    }

    static func install(on view: UIView) {
        let base: AnyClass = type(of: view)
        if String(cString: class_getName(base)).hasPrefix(prefix) { return }
        let subclass = subclasses[ObjectIdentifier(base)] ?? makeSubclass(of: base)
        object_setClass(view, subclass)
    }

    private static func makeSubclass(of base: AnyClass) -> AnyClass {
        let selector = #selector(UIView.hitTest(_:with:))
        typealias HitTest = @convention(c) (UIView, Selector, CGPoint, UIEvent?) -> UIView?
        let original = unsafeBitCast(class_getMethodImplementation(base, selector)!, to: HitTest.self)
        let name = prefix + String(cString: class_getName(base))
        let subclass: AnyClass = objc_getClass(name) as? AnyClass ?? objc_allocateClassPair(base, name, 0)!
        let block: @convention(block) (UIView, CGPoint, UIEvent?) -> UIView? = { view, point, event in
            MainActor.assumeIsolated {
                guard let hit = original(view, selector, point, event) else { return nil }
                // While the More list shows, nothing is behind: behave normally.
                guard studioVisible(on: view) else { return hit }
                return keeps(hit, below: view) ? hit : nil
            }
        }
        let encoding = method_getTypeEncoding(class_getInstanceMethod(base, selector)!)
        class_addMethod(subclass, selector, imp_implementationWithBlock(block), encoding)
        if objc_getClass(name) == nil { objc_registerClassPair(subclass) }
        subclasses[ObjectIdentifier(base)] = subclass
        return subclass
    }

    /// A hit on the tab bar or the navigation bar. Everything else, empty
    /// containers and SwiftUI-hosted content alike, belongs to the web view.
    @MainActor
    private static func keeps(_ hit: UIView, below root: UIView) -> Bool {
        var view: UIView? = hit
        while let current = view, current !== root {
            let name = NSStringFromClass(type(of: current))
            if current is UITabBar || current is UINavigationBar || name.contains("TabBar") || name.contains("NavigationBar") { return true }
            view = current.superview
        }
        return false
    }
}
