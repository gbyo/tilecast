import SwiftUI
import TilecastCore

/// Native navigation around the one Studio page, drawn entirely from the
/// catalog Studio sent. No view here knows a Tilecast destination: a Studio
/// release that adds one changes this navigation with no app release.
struct NativeNavigationShell: View {
    let page: StudioPage
    let actions: ServerActions

    var body: some View {
        NativeTabNavigation(page: page, actions: actions)
    }
}

extension NavigationCatalog.Destination {
    var imageName: String { NavigationIcon.imageName(for: icon) }
}

/// Adaptive native navigation. iPhone and horizontally compact iPad windows
/// keep a compact set of primary tabs plus More. Regular-width iPad uses
/// sidebarAdaptable as the full navigation model: primary destinations stay
/// in the top tab bar and every other Studio destination appears directly in
/// the system sidebar, grouped by Studio's catalog.
struct NativeTabNavigation: View {
    let page: StudioPage
    let actions: ServerActions
    @Environment(StudioHost.self) private var host
    @Environment(StudioSlot.self) private var slot
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var navigation: NativeNavigationModel { page.bridge.navigation }
    private var usesCompactMore: Bool {
        UIDevice.current.userInterfaceIdiom == .phone
            || horizontalSizeClass == .compact
    }

    /// Only iPhone places Studio behind the floating tab container. iPad keeps
    /// the WebView above the shell and inside the system content slot, even
    /// when a compact iPad window uses the bottom-tab + More structure.
    private var extendsBelowFloatingTabBar: Bool {
        UIDevice.current.userInterfaceIdiom == .phone
    }

    private var selection: Binding<NavigationTab> {
        Binding(
            get: {
                usesCompactMore
                    ? navigation.compactSelectedTab
                    : navigation.adaptiveSelectedTab
            },
            set: { tab in
                if usesCompactMore {
                    navigation.selectCompactTab(tab)
                } else {
                    navigation.selectAdaptiveTab(tab)
                }
            }
        )
    }

    var body: some View {
        // Native selection responds optimistically to a tap. Studio's WebView
        // is exposed in the new tab only after the route acknowledgement
        // arrives after paint.
        TabView(selection: selection) {
            ForEach(navigation.primaryDestinations) { destination in
                Tab(
                    destination.title,
                    image: destination.imageName,
                    value: NavigationTab.destination(destination.id)
                ) {
                    studio(
                        in: .destination(destination.id),
                        adaptive: !usesCompactMore
                    )
                }
            }

            if usesCompactMore {
                Tab(value: NavigationTab.more) {
                    // The More list and Studio take turns in one compact tab.
                    if navigation.compactFrontendTab == .more {
                        NavigationStack {
                            StudioSlotView(extendsBelowTabBar: extendsBelowFloatingTabBar)
                                .studioBackBar(navigation)
                                .containerBackground(.clear, for: .navigation)
                        }
                        .background {
                            StudioTabContainerBackground(studioVisible: slot.frame != nil)
                        }
                    } else {
                        NavigationStack {
                            MoreView(page: page, actions: actions)
                        }
                        .background {
                            StudioTabContainerBackground(studioVisible: slot.frame != nil)
                        }
                    }
                } label: {
                    Label("More", image: AppIcon.more)
                }
            } else {
                // sidebarOnly keeps secondary destinations out of the compact
                // top tab bar while making them first-class selections in the
                // adaptable sidebar. The groups and labels come entirely from
                // Studio's catalog.
                ForEach(navigation.secondaryGroups) { group in
                    if let title = group.title {
                        TabSection {
                            ForEach(group.destinations) { destination in
                                Tab(
                                    destination.title,
                                    image: destination.imageName,
                                    value: NavigationTab.destination(destination.id)
                                ) {
                                    studio(
                                        in: .destination(destination.id),
                                        adaptive: true
                                    )
                                }
                                .tabPlacement(.sidebarOnly)
                            }
                        } header: {
                            Text(verbatim: title)
                        }
                    } else {
                        TabSection {
                            ForEach(group.destinations) { destination in
                                Tab(
                                    destination.title,
                                    image: destination.imageName,
                                    value: NavigationTab.destination(destination.id)
                                ) {
                                    studio(
                                        in: .destination(destination.id),
                                        adaptive: true
                                    )
                                }
                                .tabPlacement(.sidebarOnly)
                            }
                        }
                    }
                }
            }
        }
        // iPadOS owns the transition between its content-first top tab bar and
        // the richer sidebar. Tilecast describes hierarchy; it does not build a
        // parallel split-view navigation system.
        .tabViewStyle(.sidebarAdaptable)
        .defaultAdaptableTabBarPlacement(.tabBar)
        .tabViewSidebarHeader {
            Menu {
                ServerMenuItems(actions: actions)
                Divider()
                Button { page.reload() } label: {
                    Label("Reload", image: AppIcon.reload)
                }
                SignOutButton(page: page)
            } label: {
                IconLabel(
                    verbatim: host.directory.activeServer?.displayName
                        ?? String(localized: "Tilecast"),
                    image: AppIcon.server
                )
            }
            .accessibilityIdentifier("native.serverMenu")
        }
        .background(.clear)
    }

    /// Studio appears in exactly one tab at a time. Compact navigation maps
    /// secondary destinations into More; regular-width iPad maps every
    /// destination to its own sidebarAdaptable tab. In both cases the
    /// confirmed frame stays put until Studio acknowledges the route after
    /// paint.
    @ViewBuilder
    private func studio(in tab: NavigationTab, adaptive: Bool) -> some View {
        let frontendTab =
            adaptive ? navigation.adaptiveFrontendTab : navigation.compactFrontendTab
        let selectedTab =
            adaptive ? navigation.adaptiveSelectedTab : navigation.compactSelectedTab
        let selectionPending =
            adaptive
                ? navigation.isAdaptiveSelectionPending
                : navigation.isCompactSelectionPending

        NavigationStack {
            if frontendTab == tab {
                StudioSlotView(extendsBelowTabBar: extendsBelowFloatingTabBar)
                    .studioBackBar(navigation)
                    .containerBackground(.clear, for: .navigation)
            } else if selectedTab == tab && selectionPending {
                Color(uiColor: .systemBackground)
                    .ignoresSafeArea()
                    .toolbar(.hidden, for: .navigationBar)
                    .containerBackground(.clear, for: .navigation)
            } else {
                Color.clear
                    .toolbar(.hidden, for: .navigationBar)
                    .containerBackground(.clear, for: .navigation)
            }
        }
        .background {
            StudioTabContainerBackground(studioVisible: slot.frame != nil)
        }
    }
}

/// The transparent-container hit-testing workaround is only needed for
/// iPhone's floating bottom tab bar. On iPad the WebView sits above the tab
/// content slot instead, which leaves the system's adaptable sidebar fully
/// interactive without depending on private sidebar view hierarchy details.
private struct StudioTabContainerBackground: View {
    let studioVisible: Bool

    var body: some View {
        if UIDevice.current.userInterfaceIdiom == .phone {
            TransparentTabContainer(studioVisible: studioVisible)
        }
    }
}

/// The More tab: Studio's other destinations, in Studio's groups, and the
/// app's own server controls.
struct MoreView: View {
    @Environment(StudioHost.self) private var host
    let page: StudioPage
    let actions: ServerActions

    private var navigation: NativeNavigationModel { page.bridge.navigation }

    var body: some View {
        List {
            ForEach(navigation.secondaryGroups) { group in
                Section {
                    ForEach(group.destinations) { destination in
                        Button {
                            navigation.open(destination.id)
                        } label: {
                            IconLabel(verbatim: destination.title, image: destination.imageName)
                        }
                        .tint(.primary)
                        .accessibilityAddTraits(destination.id == navigation.activeDestinationID ? .isSelected : [])
                    }
                } header: {
                    if let title = group.title { Text(verbatim: title).font(.geist(.footnote)) }
                }
            }
            Section {
                ForEach(host.directory.servers) { server in
                    Button {
                        Task { await host.activate(server.id) }
                    } label: {
                        HStack {
                            IconLabel(verbatim: server.displayName, image: AppIcon.server)
                                .foregroundStyle(.primary)
                            Spacer()
                            if server.id == host.directory.activeServerID {
                                Image(AppIcon.current)
                                    .foregroundStyle(.tint)
                                    .accessibilityLabel("Current server")
                            }
                        }
                    }
                    .accessibilityAddTraits(server.id == host.directory.activeServerID ? .isSelected : [])
                }
                Button(action: actions.add) { IconLabel("Add Server…", image: AppIcon.add) }
                Button(action: actions.manage) { IconLabel("Manage Servers…", image: AppIcon.manage) }
                Button { page.reload() } label: { IconLabel("Reload", image: AppIcon.reload) }
                SignOutButton(page: page)
            } header: {
                Text("Servers").font(.geist(.footnote))
            }
        }
        .navigationTitle(host.directory.activeServer?.displayName ?? String(localized: "Tilecast"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("native.more")
    }
}
