import TilecastCore
import UIKit
import VisionKit

/// Hosts the system Data Scanner for one QR scan, with native chrome: a
/// Cancel control and a concise instruction. Nothing here knows what the
/// scan is for; the recognized text goes back to whoever presented this.
@MainActor
final class QRScannerViewController: UIViewController {
    /// Called once, with how the scan ended. The presenter dismisses.
    var onFinish: (@MainActor (QRScanOutcome) -> Void)?

    private var scanner: DataScannerViewController?
    private let recognition = QRScannerRecognition()
    private var started = false
    private var finished = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = recognition
        recognition.onPayload = { [weak self] text in self?.finish(.scanned(text)) }
        addChild(scanner)
        scanner.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scanner.view)
        NSLayoutConstraint.activate([
            scanner.view.topAnchor.constraint(equalTo: view.topAnchor),
            scanner.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scanner.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scanner.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        scanner.didMove(toParent: self)
        self.scanner = scanner

        let instruction = UILabel()
        instruction.text = String(localized: "Point the camera at the Tilecast QR code.")
        instruction.textColor = .white
        instruction.font = Typography.uiFont(.body, weight: .regular)
        instruction.adjustsFontForContentSizeCategory = true
        instruction.textAlignment = .center
        instruction.numberOfLines = 0
        instruction.translatesAutoresizingMaskIntoConstraints = false
        instruction.accessibilityIdentifier = "qrscanner.instruction"

        // Camera frames can be nearly white. Keep the instruction readable
        // without covering more of the preview than necessary.
        let instructionBackground = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
        instructionBackground.translatesAutoresizingMaskIntoConstraints = false
        instructionBackground.layer.cornerRadius = 14
        instructionBackground.clipsToBounds = true
        instructionBackground.contentView.addSubview(instruction)
        view.addSubview(instructionBackground)

        var configuration = UIButton.Configuration.bordered()
        configuration.title = String(localized: "Cancel")
        configuration.baseForegroundColor = .white
        let cancel = UIButton(configuration: configuration)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        cancel.accessibilityIdentifier = "qrscanner.cancel"
        cancel.addAction(UIAction { [weak self] _ in
            Task { @MainActor in self?.finish(.cancelled) }
        }, for: .touchUpInside)
        view.addSubview(cancel)

        NSLayoutConstraint.activate([
            cancel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            cancel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            instructionBackground.topAnchor.constraint(equalTo: cancel.bottomAnchor, constant: 16),
            instructionBackground.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor),
            instructionBackground.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            instructionBackground.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            instructionBackground.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
            instruction.topAnchor.constraint(equalTo: instructionBackground.contentView.topAnchor, constant: 10),
            instruction.bottomAnchor.constraint(equalTo: instructionBackground.contentView.bottomAnchor, constant: -10),
            instruction.leadingAnchor.constraint(equalTo: instructionBackground.contentView.leadingAnchor, constant: 14),
            instruction.trailingAnchor.constraint(equalTo: instructionBackground.contentView.trailingAnchor, constant: -14),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        do {
            try scanner?.startScanning()
        } catch {
            finish(.unavailable)
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        scanner?.stopScanning()
    }

    /// Stops the camera and reports the outcome, once. Recognition can
    /// fire again while the dismissal animates; only the first payload
    /// counts.
    func finish(_ outcome: QRScanOutcome) {
        guard !finished else { return }
        finished = true
        scanner?.stopScanning()
        onFinish?(outcome)
    }
}

/// The Data Scanner's delegate. It is not MainActor-isolated, so it
/// satisfies the protocol whatever its isolation; it forwards to the
/// main actor before touching anything else.
final class QRScannerRecognition: NSObject, DataScannerViewControllerDelegate {
    var onPayload: (@MainActor (String) -> Void)?

    func dataScanner(
        _ dataScanner: DataScannerViewController,
        didAdd addedItems: [RecognizedItem],
        allItems: [RecognizedItem]
    ) {
        for item in addedItems {
            guard case .barcode(let barcode) = item,
                  let text = barcode.payloadStringValue, !text.isEmpty else { continue }
            let callback = onPayload
            Task { @MainActor in callback?(text) }
            return
        }
    }
}
