import AVFoundation
import TilecastCore
import UIKit
import VisionKit

/// Scans one QR code with the system camera, for `system/scan-qr`.
///
/// This adapter is the only UIKit in the scan path. It presents from the
/// top view controller, so a scan requested from inside a native
/// presentation appears above that sheet, and the sheet is untouched when
/// the scanner leaves. It knows nothing about pairing: it returns bounded
/// text, and Studio decides what the text means.
///
/// Camera permission is requested only here, when a scan starts: never at
/// launch, sign-in, or Fleet load.
@MainActor
enum SystemQRScanner {
    private static var isPresenting = false

    /// Whether Studio may offer scanning. Hardware the Data Scanner
    /// supports, with camera authorization that still permits a scan: the
    /// system prompts on first use. Denied or restricted hides Scan, and
    /// Studio keeps manual entry. Transient states surface at scan time.
    static var isAvailable: Bool {
        #if DEBUG
        if FixtureLaunch.qrScanner || FixtureLaunch.qrUnavailable { return true }
        #endif
        guard DataScannerViewController.isSupported else { return false }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized, .notDetermined: return true
        case .denied, .restricted: return false
        @unknown default: return false
        }
    }

    /// The outcome of one scan. The request id stays with the scan's
    /// owner; the driver only reports how scanning ended.
    static func scan(_: QRScanRequest) async -> QRScanOutcome {
        #if DEBUG
        if FixtureLaunch.qrScanner || FixtureLaunch.qrUnavailable { return await FixtureQRScanner.scan() }
        #endif
        guard !isPresenting, let presenter = TopViewController.find() else { return .unavailable }
        guard DataScannerViewController.isSupported else { return .unavailable }
        isPresenting = true
        defer { isPresenting = false }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            break
        case .notDetermined:
            guard await requestCameraAccess() else {
                await showCameraDenied(from: presenter)
                return .unavailable
            }
        case .denied, .restricted:
            await showCameraDenied(from: presenter)
            return .unavailable
        @unknown default:
            await showCameraDenied(from: presenter)
            return .unavailable
        }
        // Authorization settled; a transient state can still refuse.
        guard DataScannerViewController.isAvailable else { return .unavailable }
        guard !Task.isCancelled else { return .cancelled }

        let waiter = QRScanWaiter()
        return await withTaskCancellationHandler(operation: {
            guard !Task.isCancelled else { return .cancelled }
            return await withCheckedContinuation { continuation in
                let scanner = QRScannerViewController()
                waiter.begin(continuation: continuation, presented: scanner)
                scanner.onFinish = { [weak waiter] outcome in waiter?.finish(outcome) }
                scanner.modalPresentationStyle = .fullScreen
                presenter.present(scanner, animated: true)
            }
        }, onCancel: {
            Task { @MainActor in waiter.finish(.cancelled) }
        })
    }

    private static func requestCameraAccess() async -> Bool {
        await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .video) { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    /// Permission was denied or restricted: say so, offer Settings, and
    /// return to Studio, whose manual entry stays available.
    private static func showCameraDenied(from presenter: UIViewController) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let alert = UIAlertController(
                title: String(localized: "Camera Unavailable"),
                message: String(localized: "Tilecast can’t scan QR codes without camera access. Enter the pairing code from the Player instead, or allow the camera in Settings."),
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: String(localized: "Open Settings"), style: .default) { _ in
                Task { @MainActor in
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        await UIApplication.shared.open(url)
                    }
                }
                continuation.resume()
            })
            alert.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel) { _ in continuation.resume() })
            presenter.present(alert, animated: true)
        }
    }
}

/// One presented scanner and the continuation waiting on it. Completion,
/// cancellation, and dismissal race; the first outcome wins and the
/// continuation resumes exactly once.
///
/// Every method runs on the main actor, so sharing the reference through
/// a Sendable cancellation handler is safe: nothing touches state off the
/// main actor.
@MainActor
final class QRScanWaiter: @unchecked Sendable {
    private var continuation: CheckedContinuation<QRScanOutcome, Never>?
    private weak var presented: UIViewController?
    private var finished = false

    func begin(continuation: CheckedContinuation<QRScanOutcome, Never>, presented: UIViewController) {
        self.continuation = continuation
        self.presented = presented
    }

    func finish(_ outcome: QRScanOutcome) {
        guard !finished else { return }
        finished = true
        let continuation = continuation
        self.continuation = nil
        presented?.dismiss(animated: true)
        continuation?.resume(returning: outcome)
    }
}
