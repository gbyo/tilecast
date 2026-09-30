import PhotosUI
import SwiftUI
import TilecastCore
import UniformTypeIdentifiers

/// The Apple-native way to get media into Tilecast: system pickers, then an
/// upload with the native credential, then a small result for Studio.
///
/// It is not a media library. Studio keeps browsing, organizing, and
/// publishing. This view chooses the source (Photos or Files), presents the
/// system picker, and hands what was chosen to `MediaIntakeCoordinator`,
/// which uploads it and shows a simple progress sheet.
///
/// Every presentation here is attached to the shell root. The shell's one
/// Studio web view is never rebuilt or moved by a picker or a sheet.
private struct MediaIntakeFlow: ViewModifier {
    let coordinator: MediaIntakeCoordinator

    private enum Source { case photos, files }

    @State private var choosingSource = false
    @State private var chosenSource: Source?
    @State private var showingPhotos = false
    @State private var showingFiles = false
    @State private var photoSelection: [PhotosPickerItem] = []

    private var allowsMultiple: Bool { coordinator.request?.allowsMultiple ?? true }

    func body(content: Content) -> some View {
        content
            .onChange(of: coordinator.phase) { _, phase in
                if phase == .choosing { choosingSource = true }
            }
            .confirmationDialog("Add Media", isPresented: $choosingSource, titleVisibility: .visible) {
                Button("Photo Library") { chosenSource = .photos }
                    .accessibilityIdentifier("media.intake.photos")
                Button("Choose Files…") { chosenSource = .files }
                    .accessibilityIdentifier("media.intake.files")
                Button("Cancel", role: .cancel) {}
            }
            .onChange(of: choosingSource) { _, isShowing in
                guard !isShowing else { return }
                let source = chosenSource
                chosenSource = nil
                guard let source else {
                    // The dialog closed with no choice.
                    if coordinator.phase == .choosing { coordinator.pickerCancelled() }
                    return
                }
                #if DEBUG
                if FixtureLaunch.mediaPicker {
                    coordinator.startTransfer(FixtureLaunch.mediaSources())
                    return
                }
                #endif
                // A picker cannot present while the dialog is still leaving.
                Task {
                    try? await Task.sleep(for: .milliseconds(350))
                    switch source {
                    case .photos: showingPhotos = true
                    case .files: showingFiles = true
                    }
                }
            }
            .photosPicker(
                isPresented: $showingPhotos,
                selection: $photoSelection,
                maxSelectionCount: allowsMultiple ? nil : 1,
                selectionBehavior: .ordered,
                matching: photoFilter,
                preferredItemEncoding: .compatible
            )
            .onChange(of: showingPhotos) { _, isShowing in
                guard !isShowing else { return }
                // The selection and the dismissal arrive together.
                Task {
                    await Task.yield()
                    let selection = photoSelection
                    photoSelection = []
                    if selection.isEmpty {
                        coordinator.pickerCancelled()
                    } else {
                        coordinator.startTransfer(selection.map(PhotosMediaSource.init(item:)))
                    }
                }
            }
            .fileImporter(
                isPresented: $showingFiles,
                allowedContentTypes: fileTypes,
                allowsMultipleSelection: allowsMultiple,
                onCompletion: { result in
                    switch result {
                    case .success(let urls): coordinator.startTransfer(urls.map { FileImportSource(url: $0) })
                    case .failure: coordinator.pickerFailed()
                    }
                },
                onCancellation: { coordinator.pickerCancelled() }
            )
            .sheet(isPresented: Binding(
                get: { coordinator.phase == .transferring || coordinator.phase == .finished },
                set: { if !$0 { coordinator.dismiss() } }
            )) {
                MediaIntakeProgressView(coordinator: coordinator)
            }
    }

    private var kinds: [MediaIntakeKind] { coordinator.request?.kinds ?? MediaIntakeKind.allCases }

    private var photoFilter: PHPickerFilter {
        .any(of: kinds.map { $0 == .image ? PHPickerFilter.images : PHPickerFilter.videos })
    }

    private var fileTypes: [UTType] {
        kinds.map { $0 == .image ? UTType.image : UTType.movie }
    }
}

extension View {
    /// Adds native media intake: source choice, system pickers, and progress.
    func mediaIntake(_ coordinator: MediaIntakeCoordinator) -> some View {
        modifier(MediaIntakeFlow(coordinator: coordinator))
    }
}
