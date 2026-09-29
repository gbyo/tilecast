import SwiftUI
import TilecastCore

/// Native navigation around the one Studio page, drawn entirely from the
/// catalog Studio sent. No view here knows a Tilecast destination: a Studio
/// release that adds one changes this navigation with no app release.
struct NativeNavigationShell: View {
    let page: StudioPage
    let actions: ServerActions
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        // A regular-width iPad gets a sidebar. An iPhone, or an iPad in a
        // compact-width window, gets tabs.
        if UIDevice.current.userInterfaceIdiom == .pad, horizontalSizeClass == .regular {
            NativeSidebarNavigation(page: page, actions: actions)
        } else {
            NativeTabNavigation(page: page, actions: actions)
        }
    }
}

extension NavigationCatalog.Destination {
    var systemImage: String { NavigationIcon.systemImage(for: icon) }
}

/// iPhone: Studio's primary destinations as tabs, then the app's More tab.
struct NativeTabNavigation: View {
    let page: StudioPage
    let actions: ServerActions

    private var navigation: NativeNavigationModel { page.bridge.navigation }

    var body: some View {
        // The binding's setter only asks Studio to navigate. The selection
        // changes when Studio reports where it went.
        TabView(selection: Binding(get: { navigation.selectedTab }, set: { navigation.selectTab($0) })) {
            ForEach(navigation.primaryDestinations) { destination in
                Tab(destination.title, systemImage: destination.systemImage, value: NavigationTab.destination(destination.id)) {
                    studio(in: .destination(destination.id))
                }
            }
            Tab(value: NavigationTab.more) {
                ZStack {
                    NavigationStack {
                        MoreView(page: page, actions: actions)
                    }
                    if navigation.frontendTab == .more {
                        StudioSlotView()
                            .background(Color(uiColor: .systemBackground).ignoresSafeArea())
                    }
                }
            } label: {
                Label("More", systemImage: "ellipsis")
            }
        }
    }

    /// Studio appears in exactly one tab at a time. The slot ends above the
    /// tab bar, because Studio scrolls inside its own layout.
    @ViewBuilder private func studio(in tab: NavigationTab) -> some View {
        if navigation.frontendTab == tab {
            StudioSlotView()
        } else {
            Color.clear
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
                            Label(destination.title, systemImage: destination.systemImage)
                        }
                        .tint(.primary)
                        .accessibilityAddTraits(destination.id == navigation.activeDestinationID ? .isSelected : [])
                    }
                } header: {
                    if let title = group.title { Text(title) }
                }
            }
            Section("Servers") {
                ForEach(host.directory.servers) { server in
                    Button {
                        Task { await host.activate(server.id) }
                    } label: {
                        HStack {
                            Label(server.displayName, systemImage: "server.rack")
                                .foregroundStyle(.primary)
                            Spacer()
                            if server.id == host.directory.activeServerID {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(.tint)
                                    .accessibilityLabel("Current server")
                            }
                        }
                    }
                    .accessibilityAddTraits(server.id == host.directory.activeServerID ? .isSelected : [])
                }
                Button("Add Server…", systemImage: "plus", action: actions.add)
                Button("Manage Servers…", systemImage: "gearshape", action: actions.manage)
                Button("Reload", systemImage: "arrow.clockwise") { page.reload() }
            }
        }
        .navigationTitle(host.directory.activeServer?.displayName ?? String(localized: "Tilecast"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("native.more")
    }
}

/// Regular-width iPad: Studio's catalog as a sidebar beside the one page.
struct NativeSidebarNavigation: View {
    @Environment(StudioHost.self) private var host
    let page: StudioPage
    let actions: ServerActions

    private var navigation: NativeNavigationModel { page.bridge.navigation }

    var body: some View {
        // The sidebar stays visible: Studio's topbar replaces the detail
        // column's navigation bar, which would hold the sidebar button.
        NavigationSplitView(columnVisibility: .constant(.all)) {
            List(selection: Binding(
                get: { navigation.activeDestinationID },
                set: { if let id = $0 { navigation.open(id) } }
            )) {
                Section {
                    Menu {
                        ServerMenuItems(actions: actions)
                        Divider()
                        Button("Reload", systemImage: "arrow.clockwise") { page.reload() }
                    } label: {
                        Label(host.directory.activeServer?.displayName ?? String(localized: "Tilecast"), systemImage: "server.rack")
                    }
                    .accessibilityIdentifier("native.serverMenu")
                }
                ForEach(navigation.catalog?.groups ?? []) { group in
                    Section {
                        ForEach(group.destinations) { destination in
                            Label(destination.title, systemImage: destination.systemImage)
                                .tag(Optional(destination.id))
                        }
                    } header: {
                        if let title = group.title { Text(title) }
                    }
                }
            }
            .navigationTitle("Tilecast")
            .toolbar(removing: .sidebarToggle)
            .accessibilityIdentifier("native.sidebar")
        } detail: {
            StudioSlotView()
                .ignoresSafeArea(edges: .bottom)
                .toolbar(.hidden, for: .navigationBar)
        }
        .navigationSplitViewStyle(.balanced)
    }
}
