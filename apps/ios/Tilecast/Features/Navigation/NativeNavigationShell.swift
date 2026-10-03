import SwiftUI
import TilecastCore

/// Native navigation around the one Studio page, drawn entirely from the
/// catalog Studio sent. No view here knows a Tilecast destination: a Studio
/// release that adds one changes this navigation with no app release.
struct NativeNavigationShell: View {
    let page: StudioPage
    let actions: ServerActions
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    /// A regular-width iPad gets a sidebar. An iPhone, or an iPad in a
    /// compact-width window, gets tabs.
    static func usesTabs(horizontalSizeClass: UserInterfaceSizeClass?) -> Bool {
        !(UIDevice.current.userInterfaceIdiom == .pad && horizontalSizeClass == .regular)
    }

    var body: some View {
        if Self.usesTabs(horizontalSizeClass: horizontalSizeClass) {
            NativeTabNavigation(page: page, actions: actions)
        } else {
            NativeSidebarNavigation(page: page, actions: actions)
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
    @Environment(StudioSlot.self) private var slot

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
                // Studio is behind the tabs and this container is transparent,
                // so the list and Studio take turns instead of stacking.
                if navigation.frontendTab == .more {
                    NavigationStack {
                        StudioSlotView(extendsBelowTabBar: true)
                            .studioBackBar(navigation)
                            .containerBackground(.clear, for: .navigation)
                    }
                    .background { TransparentTabContainer(studioVisible: slot.frame != nil) }
                } else {
                    NavigationStack {
                        MoreView(page: page, actions: actions)
                    }
                    .background { TransparentTabContainer(studioVisible: slot.frame != nil) }
                }
            } label: {
                Label("More", image: AppIcon.more)
            }
        }
        // Studio is drawn behind the tabs, so the tab container must not
        // paint over it. The More list draws its own background.
        .background(.clear)
    }

    /// Studio appears in exactly one tab at a time. Its slot reaches beneath
    /// the floating tab bar, and the web view is drawn behind the tabs, so
    /// the glass samples the page itself.
    @ViewBuilder private func studio(in tab: NavigationTab) -> some View {
        NavigationStack {
            if navigation.frontendTab == tab {
                StudioSlotView(extendsBelowTabBar: true)
                    .studioBackBar(navigation)
                    .containerBackground(.clear, for: .navigation)
            } else {
                Color.clear
                    .toolbar(.hidden, for: .navigationBar)
                    .containerBackground(.clear, for: .navigation)
            }
        }
        .background { TransparentTabContainer(studioVisible: slot.frame != nil) }
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
                            HStack {
                                IconLabel(verbatim: destination.title, image: destination.imageName)
                                Spacer()
                                if destination.id == navigation.activeDestinationID {
                                    Image(AppIcon.current)
                                        .foregroundStyle(.tint)
                                        .accessibilityHidden(true)
                                }
                            }
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
                        HStack(spacing: 12) {
                            Image(AppIcon.server)
                                .foregroundStyle(.primary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: server.displayName)
                                    .foregroundStyle(.primary)
                                Text(verbatim: server.address.displayString)
                                    .font(.geist(.footnote))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
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
            } header: {
                Text("Servers").font(.geist(.footnote))
            }
            Section {
                Button { page.reload() } label: { IconLabel("Reload", image: AppIcon.reload) }
                SignOutButton(page: page)
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
