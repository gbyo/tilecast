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

/// Adaptive top-level navigation. iPhone uses the system bottom tab bar.
/// iPadOS starts content-first with its top tab bar and lets people reveal
/// the system sidebar when the window has room for it.
struct NativeTabNavigation: View {
    let page: StudioPage
    let actions: ServerActions
    @Environment(StudioHost.self) private var host
    @Environment(StudioSlot.self) private var slot

    private var navigation: NativeNavigationModel { page.bridge.navigation }

    var body: some View {
        // The tab bar responds optimistically to a tap. Studio's WebView is
        // exposed only after the route acknowledgement arrives after paint.
        TabView(selection: Binding(get: { navigation.selectedTab }, set: { navigation.selectTab($0) })) {
            ForEach(navigation.primaryDestinations) { destination in
                Tab(destination.title, image: destination.imageName, value: NavigationTab.destination(destination.id)) {
                    studio(in: .destination(destination.id))
                }
            }
            Tab(value: NavigationTab.more) {
                // The list and Studio take turns in the same adaptive tab.
                // iPhone composites Studio behind the tab container; iPad
                // overlays Studio only inside this tab's measured content slot.
                if navigation.frontendTab == .more {
                    NavigationStack {
                        StudioSlotView(extendsBelowTabBar: true)
                            .studioBackBar(navigation)
                            .containerBackground(.clear, for: .navigation)
                    }
                    .background { StudioTabContainerBackground(studioVisible: slot.frame != nil) }
                } else {
                    NavigationStack {
                        MoreView(page: page, actions: actions)
                    }
                    .background { StudioTabContainerBackground(studioVisible: slot.frame != nil) }
                }
            } label: {
                Label("More", image: AppIcon.more)
            }
        }
        // Let iPadOS choose the representation as the window changes instead
        // of treating every regular-width iPad as a permanently split layout.
        // Apple recommends starting with the tab bar when content space matters;
        // people can reveal the system sidebar when they want the hierarchy.
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
        // Keep the adaptive container itself clear. iPhone composes Studio
        // behind it; iPad overlays Studio only inside the measured content slot.
        .background(.clear)
    }

    /// Studio appears in exactly one tab at a time. On iPhone its slot reaches
    /// beneath the floating tab bar so the glass samples the page. On iPad the
    /// slot instead bounds the overlay to the system tab/sidebar detail area.
    @ViewBuilder private func studio(in tab: NavigationTab) -> some View {
        NavigationStack {
            if navigation.frontendTab == tab {
                StudioSlotView(extendsBelowTabBar: true)
                    .studioBackBar(navigation)
                    .containerBackground(.clear, for: .navigation)
            } else if navigation.selectedTab == tab && navigation.isTabSelectionPending {
                // The native selection has moved, but WebKit has not yet
                // confirmed a painted frame for this destination. Cover the
                // persistent WebView briefly instead of exposing its stale
                // composited frame under the new tab.
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
        .background { StudioTabContainerBackground(studioVisible: slot.frame != nil) }
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
            ForEach(navigation.moreGroups) { group in
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
                    if let title = group.title { Text(title).font(.geist(.footnote)) }
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
