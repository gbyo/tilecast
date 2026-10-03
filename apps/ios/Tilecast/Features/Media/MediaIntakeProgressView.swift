import SwiftUI
import TilecastCore

/// Upload progress, in the system's plain style: a name, a state, and a bar.
/// It is not a media library. Browsing, organizing, and publishing what was
/// uploaded is Studio's.
struct MediaIntakeProgressView: View {
    let coordinator: MediaIntakeCoordinator

    private var isTransferring: Bool { coordinator.phase == .transferring }

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(coordinator.items.enumerated()), id: \.element.id) { index, item in
                    MediaIntakeRow(item: item, index: index + 1)
                }
            }
            .navigationTitle(isTransferring ? String(localized: "Uploading Media") : String(localized: "Media Upload"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if isTransferring {
                        Button("Cancel") { coordinator.cancel() }
                            .accessibilityIdentifier("media.intake.cancel")
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { coordinator.dismiss() }
                        .disabled(isTransferring)
                        .accessibilityIdentifier("media.intake.done")
                }
            }
        }
        .presentationDetents([.medium, .large])
        // Swiping the sheet away would end an upload by accident. Cancel is explicit.
        .interactiveDismissDisabled(isTransferring)
        .accessibilityIdentifier("media.intake.sheet")
    }
}

private struct MediaIntakeRow: View {
    let item: MediaIntakeCoordinator.Item
    let index: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.name ?? String(localized: "Item \(index)"))
                .font(.geist(.body))
                .lineLimit(1)
                .truncationMode(.middle)
            switch item.state {
            case .preparing:
                status("Preparing…", tint: .secondary)
                ProgressView().controlSize(.small)
            case .uploading:
                status("Uploading… \(Int((item.fraction * 100).rounded()))%", tint: .secondary)
                ProgressView(value: item.fraction)
            case .processing(let fraction):
                status("Processing on the server…", tint: .secondary)
                if let fraction { ProgressView(value: fraction) } else { ProgressView().controlSize(.small) }
            case .completed:
                Label("Uploaded", systemImage: "checkmark.circle.fill")
                    .font(.geist(.footnote))
                    .foregroundStyle(.green)
            case .failed(let error):
                Label(error.message, systemImage: "exclamationmark.triangle.fill")
                    .font(.geist(.footnote))
                    .foregroundStyle(.red)
            case .cancelled:
                status("Cancelled", tint: .secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("media.intake.row")
    }

    private func status(_ text: LocalizedStringKey, tint: Color) -> some View {
        Text(text).font(.geist(.footnote)).foregroundStyle(tint)
    }
}
