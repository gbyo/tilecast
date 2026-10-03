import Foundation
import Observation

/// The menus Studio asked the app to show for the active server, and the
/// page that asked for each.
///
/// A menu belongs to the page that presented or armed it, so the main
/// Studio page and the presentation page each use this center. Only one
/// menu shows at a time for a three-dot tap; a second request is refused,
/// and Studio then shows its own web menu. Arming replaces: a long press
/// is always preceded by a fresh arm from the pressed target, so the
/// latest arm wins. A menu goes away with its page: a new document, a
/// closed page, or a presentation that ended.
///
/// A long press copies the armed menu into `showing`: the menu on
/// screen is then independent of later arms and disarms, so a choice from
/// it is never confused with a newer menu, and a menu Studio replaced is
/// never answered. Copying is idempotent, so building the menu twice for
/// one gesture is harmless.
@MainActor
@Observable
public final class NativeActionMenuCenter {
    public struct Presented: Equatable, Sendable {
        public let menu: NativeActionMenu
        public let context: NativeBridgeProtocol.Context
    }

    /// The menu showing now for a three-dot tap.
    public private(set) var immediate: Presented?
    /// The menu armed for a long press.
    public private(set) var armed: Presented?
    /// The armed menu a long press consumed and shows now.
    public private(set) var showing: Presented?
    @ObservationIgnored private weak var immediateOwner: StudioBridge?
    @ObservationIgnored private weak var armedOwner: StudioBridge?
    @ObservationIgnored private weak var showingOwner: StudioBridge?

    public init() {}

    /// The presented menu to show over the page of `context`, or nil. The
    /// main page and a presentation sheet each show only their own.
    public func menu(for context: NativeBridgeProtocol.Context) -> NativeActionMenu? {
        immediate?.context == context ? immediate?.menu : nil
    }

    /// The armed menu a long press on the page of `context` may show.
    public func armedMenu(for context: NativeBridgeProtocol.Context) -> NativeActionMenu? {
        armed?.context == context ? armed?.menu : nil
    }

    func present(_ menu: NativeActionMenu, from bridge: StudioBridge) -> Bool {
        guard immediate == nil else { return false }
        immediate = Presented(menu: menu, context: bridge.context)
        immediateOwner = bridge
        return true
    }

    /// Arms a context menu, replacing any menu armed before. A long press
    /// always re-arms first, so the latest arm is the fresh one. A new arm
    /// supersedes a consumed menu: its gesture ended before this one began.
    func arm(_ menu: NativeActionMenu, from bridge: StudioBridge) {
        armed = Presented(menu: menu, context: bridge.context)
        armedOwner = bridge
        showing = nil
        showingOwner = nil
    }

    /// A long press builds its menu from the armed menu of its page. The
    /// menu is copied to `showing`, so later arms and disarms cannot change
    /// what is on screen. Returns the menu to render, or nil for the
    /// default menu when nothing is armed for this page.
    public func consumeArmed(for context: NativeBridgeProtocol.Context) -> NativeActionMenu? {
        guard armed?.context == context, let presented = armed else { return nil }
        showing = presented
        showingOwner = armedOwner
        return presented.menu
    }

    /// Studio withdrew the menu, for example when the menu's owner went
    /// away. A menu a long press already shows keeps showing, and its
    /// choice still counts: withdrawing is Studio forgetting, not the
    /// user dismissing.
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

    /// Studio's page went away. Its menus go with it.
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
    }

    /// The presentation ended, so its menus cannot outlive it.
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
    }

    /// The user chose an action of the presented menu. Studio hears which
    /// one. A disabled or unknown action changes nothing.
    public func choose(actionID: String) {
        guard let presented = immediate,
              let action = presented.menu.items.first(where: { $0.id == actionID }),
              !action.isDisabled else { return }
        let owner = immediateOwner
        immediate = nil
        immediateOwner = nil
        Task { await owner?.send(NativeBridgeProtocol.actionMenuAction(menuID: presented.menu.id, actionID: actionID)) }
    }

    /// The user chose an action of the consumed context menu. Only that
    /// menu answers: a choice from any other menu id is stale and ignored.
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

    /// The user dismissed the presented menu without choosing. Studio
    /// hears that nothing was chosen.
    public func dismissImmediate() {
        guard let presented = immediate else { return }
        let owner = immediateOwner
        immediate = nil
        immediateOwner = nil
        Task { await owner?.send(NativeBridgeProtocol.actionMenuDismissed(menuID: presented.menu.id)) }
    }

    /// The user dismissed the consumed context menu without choosing.
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
