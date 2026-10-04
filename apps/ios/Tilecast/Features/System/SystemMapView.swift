import MapKit
import SwiftUI
import TilecastCore

/// MapKit rendering for the generic system-map bridge surface.
///
/// The app receives already-localized labels plus coordinates and opaque
/// actions. Nothing here knows which Tilecast feature supplied the points.
struct SystemMapView: View {
    let center: SystemMapCenter
    let presentation: SystemMapPresentation

    @State private var position: MapCameraPosition = .automatic
    @State private var selection: String?

    private var snapshot: SystemMapPresentation {
        center.current ?? presentation
    }

    private var selectedPoint: SystemMapPoint? {
        guard let selection else { return nil }
        return snapshot.points.first { $0.id == selection }
    }

    var body: some View {
        NavigationStack {
            Map(position: $position, selection: $selection) {
                ForEach(snapshot.points) { point in
                    Marker(
                        point.title,
                        coordinate: CLLocationCoordinate2D(
                            latitude: point.latitude,
                            longitude: point.longitude
                        )
                    )
                    .tint(markerColor(point.tone))
                    .tag(point.id)
                }
            }
            .mapControls {
                MapCompass()
                MapScaleView()
                MapPitchToggle()
            }
            .safeAreaInset(edge: .bottom) {
                if let selectedPoint {
                    pointCard(selectedPoint)
                        .padding(.horizontal)
                        .padding(.bottom, 8)
                }
            }
            .navigationTitle(snapshot.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { center.userDismissed() }
                }
            }
        }
    }

    private func pointCard(_ point: SystemMapPoint) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(point.title)
                    .font(.geist(.body).weight(.semibold))
                    .lineLimit(1)
                if let subtitle = point.subtitle {
                    Text(subtitle)
                        .font(.geist(.footnote))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            if let actionID = point.actionID {
                Button {
                    center.perform(actionID: actionID)
                } label: {
                    Label("Open", systemImage: "arrow.up.right.square")
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .shadow(radius: 8, y: 3)
    }

    private func markerColor(_ tone: SystemMapTone) -> Color {
        switch tone {
        case .default: .accentColor
        case .positive: .green
        case .warning: .orange
        case .critical: .red
        case .muted: .gray
        }
    }
}
