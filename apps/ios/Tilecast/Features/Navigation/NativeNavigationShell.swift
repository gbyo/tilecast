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
    var imageName: String { NavigationIcon.imageName(for: icon) }
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
                Tab(destination.title, image: destination.imageName, value: NavigationTab.destination(destination.id)) {
                    studio(in: .destination(destination.id))
                }
            }
            Tab(value: NavigationTab.more) {
                ZStack {
                    NavigationStack {
                        MoreView(page: page, actions: actions)
                    }
                    if navigation.frontendTab == .more {
                        NavigationStack {
                            StudioSlotView()
                                .studioBackBar(navigation)
                        }
                        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
                    }
                }
            } label: {
                Label("More", image: AppIcon.more)
            }
        }
    }

    /// Studio appears in exactly one tab at a time. The slot ends above the
    /// tab bar, because Studio scrolls inside its own layout.
    @ViewBuilder private func studio(in tab: NavigationTab) -> some View {
        NavigationStack {
            if navigation.frontendTab == tab {
                StudioSlotView()
                    .studioBackBar(navigation)
            } else {
                Color.clear
                    .toolbar(.hidden, for: .navigationBar)
            }
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
                        Button { page.reload() } label: { Label("Reload", image: AppIcon.reload) }
                        SignOutButton(page: page)
                    } label: {
                        IconLabel(verbatim: host.directory.activeServer?.displayName ?? String(localized: "Tilecast"), image: AppIcon.server)
                    }
                    .accessibilityIdentifier("native.serverMenu")
                }
                ForEach(navigation.catalog?.groups ?? []) { group in
                    Section {
                        ForEach(group.destinations) { destination in
                            IconLabel(verbatim: destination.title, image: destination.imageName)
                                .tag(Optional(destination.id))
                        }
                    } header: {
                        if let title = group.title { Text(title).font(.geist(.footnote)) }
                    }
                }
            }
            .navigationTitle("Tilecast")
            .toolbar(removing: .sidebarToggle)
            .accessibilityIdentifier("native.sidebar")
        } detail: {
            StudioSlotView()
                .ignoresSafeArea(edges: .bottom)
                .studioBackBar(navigation)
        }
        .navigationSplitViewStyle(.balanced)
    }
}
