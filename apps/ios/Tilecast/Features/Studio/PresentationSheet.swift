import SwiftUI
import TilecastCore
import WebKit

/// A Studio route presented natively.
///
/// Studio owns the content; this view owns the presentation. The title,
/// subtitle, toolbar, size, and dismissibility come only from Studio's
/// descriptor, so no presentation needs code here. The web content is the
/// one reusable presentation page.
struct PresentationSheet: View {
    let coordinator: PresentationCoordinator
    /// The presentation this sheet was opened for. A late dismissal of it
    /// must not end a newer one.
    let presentationID: String
    /// iPad sizing is chosen once, from the size the presentation opened
    /// with. Detents follow later updates.
    let openedCompact: Bool
    @State private var detent: PresentationDetent
    /// The last descriptor, so the sheet keeps its chrome while it animates
    /// away after the presentation ended.
    @State private var last: NativePresentation
    @State private var showingDownloadNotice = false
    @Environment(\.openURL) private var openURL

    init(coordinator: PresentationCoordinator, presentation: NativePresentation) {
        self.coordinator = coordinator
        presentationID = presentation.id
        openedCompact = presentation.size == .compact
        _detent = State(initialValue: presentation.size == .compact ? .medium : .large)
        _last = State(initialValue: presentation)
    }

    /// The live descriptor while this sheet's presentation is current.
    private var presentation: NativePresentation? {
        coordinator.presentation.flatMap { $0.id == presentationID ? $0 : nil } ?? last
    }


    private var size: PresentationSize { presentation?.size ?? .full }

    var body: some View {
        NavigationStack {
            content
                .modifier(PresentationTitle(header: presentation?.header))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
        }
        // Compact starts at half height and can grow. Studio can ask a
        // compact sheet to grow, for example under a dialog; the app never
        // shrinks a sheet the user is using.
        .presentationDetents(size == .compact ? [.medium, .large] : [.large], selection: $detent)
        .presentationDragIndicator(size == .compact ? .visible : .hidden)
        .modifier(PresentationSizingChoice(compact: openedCompact))
        .interactiveDismissDisabled(presentation?.isDismissible == false)
        .onChange(of: size) { if size == .full { detent = .large } }
        .onChange(of: coordinator.presentation) {
            if let current = coordinator.presentation, current.id == presentationID { last = current }
        }
        .onChange(of: coordinator.pendingEvents, initial: true) { perform(coordinator.takeEvents()) }
        .alert("Downloads Aren’t Available Yet", isPresented: $showingDownloadNotice) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("To download this file, open Tilecast Studio in Safari.")
        }
    }

    @ViewBuilder private var content: some View {
        ZStack {
            if let page = coordinator.page {
                WebView(page.webPage)
                    .webViewBackForwardNavigationGestures(.disabled)
                    .webViewLinkPreviews(.disabled)
                    .id(ObjectIdentifier(page))
                    .ignoresSafeArea(edges: .bottom)
                    .accessibilityHidden(coordinator.contentState != .ready)
            }
            switch coordinator.contentState {
            case .ready:
                EmptyView()
            case .loading:
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.background)
                    .accessibilityIdentifier("presentation.loading")
            case .failed(let failure):
                ContentUnavailableView {
                    Label("Couldn’t Open This View", systemImage: "exclamationmark.triangle")
                        .font(.geist(.title2).weight(.bold))
                } description: {
                    Text(failure.message)
                        .font(.geist(.body))
                } actions: {
                    Button("Try Again") { coordinator.retry() }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("presentation.retry")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.background)
            }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) { leadingControl }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if let header = presentation?.header, coordinator.contentState == .ready {
                ForEach(header.actions) { action in
                    Button {
                        coordinator.perform(actionID: action.id)
                    } label: {
                        ToolbarIcon(image: NavigationIcon.imageName(for: action.icon))
                    }
                    .accessibilityLabel(Text(verbatim: action.label))
                    .accessibilityIdentifier("presentation.action.\(action.id)")
                }
                if !header.menu.isEmpty { menu(header) }
            }
        }
    }

    /// Close, or back when Studio says the presentation has somewhere to go
    /// back to. A failed presentation always offers close.
    @ViewBuilder private var leadingControl: some View {
        let header = presentation?.header
        if header?.navigation == .back, coordinator.contentState == .ready {
            Button {
                coordinator.perform(actionID: PresentationHeader.backActionID)
            } label: {
                Image(systemName: "chevron.backward")
            }
            .accessibilityLabel(header?.navigationLabel.map { Text(verbatim: $0) } ?? Text("Back"))
            .accessibilityIdentifier("presentation.back")
        } else {
            Button(role: .close) { coordinator.dismiss(presentationID: presentationID) }
                .accessibilityLabel(header?.navigationLabel.map { Text(verbatim: $0) } ?? Text("Close"))
                .accessibilityIdentifier("presentation.close")
        }
    }

    private func menu(_ header: PresentationHeader) -> some View {
        Menu {
            ForEach(header.menu) { item in
                Button {
                    coordinator.perform(actionID: item.id)
                } label: {
                    if let icon = item.icon {
                        Label {
                            Text(verbatim: item.label)
                        } icon: {
                            Image(NavigationIcon.imageName(for: icon))
                        }
                    } else {
                        Text(verbatim: item.label)
                    }
                }
                .disabled(item.isDisabled)
            }
        } label: {
            ToolbarIcon(image: AppIcon.more)
        }
        .accessibilityLabel(header.menuLabel.map { Text(verbatim: $0) } ?? Text("More"))
        .accessibilityIdentifier("presentation.menu")
    }

    private func perform(_ events: [StudioPageEvent]) {
        for event in events {
            switch event {
            case .openExternally(let url): openURL(url)
            case .unsupportedDownload: showingDownloadNotice = true
            case .signIn: break
            }
        }
    }
}

/// A form-sized sheet for compact presentations and a page-sized one for
/// full presentations, on iPad. iPhone sheets fill the width either way.
private struct PresentationSizingChoice: ViewModifier {
    let compact: Bool

    func body(content: Content) -> some View {
        if compact {
            content.presentationSizing(.form)
        } else {
            content.presentationSizing(.page)
        }
    }
}

/// Studio's title and optional subtitle, shown verbatim: Studio localized
/// them already.
private struct PresentationTitle: ViewModifier {
    let header: PresentationHeader?

    func body(content: Content) -> some View {
        if let subtitle = header?.subtitle {
            content
                .navigationTitle(header?.title ?? "")
                .navigationSubtitle(subtitle)
        } else {
            content.navigationTitle(header?.title ?? "")
        }
    }
}

/// A Lucide icon sized like a toolbar symbol. It follows Dynamic Type.
private struct ToolbarIcon: View {
    let image: String
    @ScaledMetric(relativeTo: .body) private var size = 20

    var body: some View {
        Image(image)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
    }
}

extension PresentationFailure {
    var message: String {
        switch self {
        case .unreachable:
            String(localized: "Check your connection, then try again.")
        case .untrustedCertificate:
            String(localized: "The server’s certificate isn’t valid or isn’t trusted by this device.")
        case .contentProcessEnded:
            String(localized: "This view stopped unexpectedly.")
        case .unavailable, .refused, .other:
            String(localized: "Tilecast Studio couldn’t open this view.")
        }
    }
}
