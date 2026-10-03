import Foundation
import Observation

/// Generic native action-menu state for the active server.
///
/// Studio owns every label, action and callback. The app only owns native
/// presentation. Long presses use one armed menu; ordinary ellipsis buttons
/// register normalized trigger rectangles that the app overlays with real
/// SwiftUI Menu controls.
@MainActor
@Observable
public final class NativeActionMenuCenter {
    public struct Presented: Equatable, Sendable {
        public let menu: NativeActionMenu
        public let context: NativeBridgeProtocol.Context
    }

    public struct Trigger: Equatable, Sendable, Identifiable {
        public let menu: NativeActionMenu
        public let context: NativeBridgeProtocol.Context
        public let rect: NativeActionMenuTriggerRect
        public var id: String { menu.id }
    }

    private final class WeakOwner {
        weak var bridge: StudioBridge?
        init(_ bridge: StudioBridge) { self.bridge = bridge }
    }

    /// Legacy immediate state. New hosts refuse action-menu/present so Studio
    /// falls back to its web menu instead of showing an action sheet.
    public private(set) var immediate: Presented?
    /// The menu armed for a long press.
    public private(set) var armed: Presented?
    /// The armed menu a long press consumed and shows now.
    public private(set) var showing: Presented?
    /// Visible HTML action triggers mirrored as invisible native Menu anchors.
    public private(set) var triggers: [Trigger] = []

    @ObservationIgnored private weak var immediateOwner: StudioBridge?
    @ObservationIgnored private weak var armedOwner: StudioBridge?
    @ObservationIgnored private weak var showingOwner: StudioBridge?
    @ObservationIgnored private var triggerOwners: [String: WeakOwner] = [:]

    static let maximumTriggers = 64

    public init() {}

    public func menu(for context: NativeBridgeProtocol.Context) -> NativeActionMenu? {
        immediate?.context == context ? immediate?.menu : nil
    }

    public func armedMenu(for context: NativeBridgeProtocol.Context) -> NativeActionMenu? {
        armed?.context == context ? armed?.menu : nil
    }

    public func triggers(for context: NativeBridgeProtocol.Context) -> [Trigger] {
        triggers.filter { $0.context == context }
    }

    /// Kept only for bridge compatibility. New Studio should use an anchored
    /// trigger and new hosts intentionally refuse immediate presentation.
    func present(_ menu: NativeActionMenu, from bridge: StudioBridge) -> Bool {
        guard immediate == nil else { return false }
        immediate = Presented(menu: menu, context: bridge.context)
        immediateOwner = bridge
        return true
    }

    func registerTrigger(
        _ menu: NativeActionMenu,
        rect: NativeActionMenuTriggerRect,
        from bridge: StudioBridge
    ) -> Bool {
        if let owner = triggerOwners[menu.id]?.bridge, owner !== bridge {
            return false
        }
        let trigger = Trigger(menu: menu, context: bridge.context, rect: rect)
        if let index = triggers.firstIndex(where: { $0.id == menu.id }) {
            triggers[index] = trigger
        } else {
            guard triggers.count < Self.maximumTriggers else { return false }
            triggers.append(trigger)
        }
        triggerOwners[menu.id] = WeakOwner(bridge)
        return true
    }

    func unregisterTrigger(menuID: String, from bridge: StudioBridge) {
        guard triggerOwners[menuID]?.bridge === bridge else { return }
        triggers.removeAll { $0.id == menuID }
        triggerOwners.removeValue(forKey: menuID)
    }

    func arm(_ menu: NativeActionMenu, from bridge: StudioBridge) {
        armed = Presented(menu: menu, context: bridge.context)
        armedOwner = bridge
        showing = nil
        showingOwner = nil
    }

    public func consumeArmed(for context: NativeBridgeProtocol.Context) -> NativeActionMenu? {
        guard armed?.context == context, let presented = armed else { return nil }
        showing = presented
        showingOwner = armedOwner
        return presented.menu
    }

    func disarm(menuID: String, from bridge: StudioBridge) {
        if immediateOwner === bridge, immediate?.menu.id == menuID {
            immediate = nil
            immediateOwner = nil
        }
        if armedOwner === bridge, armed?.menu.id == menuID {
            armed = nil
            armedOwner = nil
        }
    }

    func withdraw(from bridge: StudioBridge) {
        if immediateOwner === bridge {
            immediate = nil
            immediateOwner = nil
        }
        if armedOwner === bridge {
            armed = nil
            armedOwner = nil
        }
        if showingOwner === bridge {
            showing = nil
            showingOwner = nil
        }
        let ids = triggerOwners.compactMap { id, owner in
            owner.bridge === bridge ? id : nil
        }
        if !ids.isEmpty {
            let set = Set(ids)
            triggers.removeAll { set.contains($0.id) }
            for id in ids { triggerOwners.removeValue(forKey: id) }
        }
    }

    func withdraw(context: NativeBridgeProtocol.Context) {
        if immediate?.context == context {
            immediate = nil
            immediateOwner = nil
        }
        if armed?.context == context {
            armed = nil
            armedOwner = nil
        }
        if showing?.context == context {
            showing = nil
            showingOwner = nil
        }
        let ids = triggers.filter { $0.context == context }.map(\.id)
        if !ids.isEmpty {
            let set = Set(ids)
            triggers.removeAll { set.contains($0.id) }
            for id in ids { triggerOwners.removeValue(forKey: id) }
        }
    }

    public func choose(actionID: String) {
        guard let presented = immediate,
              let action = presented.menu.items.first(where: { $0.id == actionID }),
              !action.isDisabled else { return }
        let owner = immediateOwner
        immediate = nil
        immediateOwner = nil
        Task { await owner?.send(NativeBridgeProtocol.actionMenuAction(menuID: presented.menu.id, actionID: actionID)) }
    }

    /// A native Menu selection. Registration remains because the same
    /// ellipsis button can be used again without another DOM interaction.
    public func chooseTrigger(actionID: String, menuID: String) {
        guard let trigger = triggers.first(where: { $0.id == menuID }),
              let owner = triggerOwners[menuID]?.bridge,
              let action = trigger.menu.items.first(where: { $0.id == actionID }),
              !action.isDisabled else { return }
        Task { await owner.send(NativeBridgeProtocol.actionMenuAction(menuID: menuID, actionID: actionID)) }
    }

    public func chooseShowing(actionID: String, menuID: String) {
        guard let presented = showing, presented.menu.id == menuID,
              let action = presented.menu.items.first(where: { $0.id == actionID }),
              !action.isDisabled else { return }
        let owner = showingOwner
        showing = nil
        showingOwner = nil
        if armed?.menu.id == menuID {
            armed = nil
            armedOwner = nil
        }
        Task { await owner?.send(NativeBridgeProtocol.actionMenuAction(menuID: menuID, actionID: actionID)) }
    }

    public func dismissImmediate() {
        guard let presented = immediate else { return }
        let owner = immediateOwner
        immediate = nil
        immediateOwner = nil
        Task { await owner?.send(NativeBridgeProtocol.actionMenuDismissed(menuID: presented.menu.id)) }
    }

    public func dismissShowing(menuID: String) {
        guard let presented = showing, presented.menu.id == menuID else { return }
        let owner = showingOwner
        showing = nil
        showingOwner = nil
        if armed?.menu.id == menuID {
            armed = nil
            armedOwner = nil
        }
        Task { await owner?.send(NativeBridgeProtocol.actionMenuDismissed(menuID: menuID)) }
    }
}
