#if DEBUG
import TilecastCore
import UIKit

/// A DEBUG-only stand-in for the physical camera. UI tests launch with
/// `-TilecastFixtureQRScanner` to show a stub scanner whose Simulate
/// button returns `-TilecastFixtureQRPayload`, or with
/// `-TilecastFixtureQRUnavailable` to fail without showing anything.
/// The fake replaces only recognition: the bridge, the presentation, and
/// the React flow after it are the real ones. Release builds contain none
/// of this. Strings stay verbatim English: a test device needs no catalog.
@MainActor
enum FixtureQRScanner {
    /// What Simulate returns when the launch arguments name no payload.
    /// It parses as a pairing QR for the wrong installation, so Studio
    /// shows its mismatch error deterministically.
    static let defaultPayload = "https://signage.example.org/screens/pair/K7Q2XD?installation=00000000-0000-0000-0000-000000000000"

    private static var isPresenting = false

    static func scan() async -> QRScanOutcome {
        guard !FixtureLaunch.qrUnavailable else { return .unavailable }
        guard !isPresenting, let presenter = TopViewController.find() else { return .unavailable }
        isPresenting = true
        defer { isPresenting = false }
        guard !Task.isCancelled else { return .cancelled }

        let waiter = QRScanWaiter()
        return await withTaskCancellationHandler(operation: {
            guard !Task.isCancelled else { return .cancelled }
            return await withCheckedContinuation { continuation in
                let stub = FixtureQRScannerViewController(payload: FixtureLaunch.qrPayload ?? defaultPayload)
                waiter.begin(continuation: continuation, presented: stub)
                stub.onFinish = { [weak waiter] outcome in waiter?.finish(outcome) }
                stub.modalPresentationStyle = .fullScreen
                presenter.present(stub, animated: true)
            }
        }, onCancel: {
            Task { @MainActor in waiter.finish(.cancelled) }
        })
    }
}

/// The stub scanner screen: the payload it will return, a Simulate
/// button, and Cancel. Identifiers, not labels, are the UI tests'
/// contract.
@MainActor
final class FixtureQRScannerViewController: UIViewController {
    var onFinish: (@MainActor (QRScanOutcome) -> Void)?

    private let payload: String
    private var finished = false

    init(payload: String) {
        self.payload = payload
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let title = UILabel()
        title.text = "Fixture QR Scanner"
        title.textColor = .white
        title.font = .preferredFont(forTextStyle: .headline)
        title.textAlignment = .center
        title.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(title)

        let payloadLabel = UILabel()
        payloadLabel.text = payload
        payloadLabel.textColor = .lightGray
        payloadLabel.font = .preferredFont(forTextStyle: .footnote)
        payloadLabel.textAlignment = .center
        payloadLabel.numberOfLines = 0
        payloadLabel.translatesAutoresizingMaskIntoConstraints = false
        payloadLabel.accessibilityIdentifier = "fixture.qr.payload"
        view.addSubview(payloadLabel)

        var simulateConfiguration = UIButton.Configuration.filled()
        simulateConfiguration.title = "Simulate Scan"
        let simulate = UIButton(configuration: simulateConfiguration)
        simulate.translatesAutoresizingMaskIntoConstraints = false
        simulate.accessibilityIdentifier = "fixture.qr.simulate"
        simulate.addAction(UIAction { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.finish(.scanned(self.payload))
            }
        }, for: .touchUpInside)
        view.addSubview(simulate)

        var cancelConfiguration = UIButton.Configuration.bordered()
        cancelConfiguration.title = "Cancel"
        let cancel = UIButton(configuration: cancelConfiguration)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        cancel.accessibilityIdentifier = "fixture.qr.cancel"
        cancel.addAction(UIAction { [weak self] _ in
            Task { @MainActor in self?.finish(.cancelled) }
        }, for: .touchUpInside)
        view.addSubview(cancel)

        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 48),
            title.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 32),
            title.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -32),
            payloadLabel.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 16),
            payloadLabel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 32),
            payloadLabel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -32),
            simulate.topAnchor.constraint(equalTo: payloadLabel.bottomAnchor, constant: 32),
            simulate.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cancel.topAnchor.constraint(equalTo: simulate.bottomAnchor, constant: 16),
            cancel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        ])
    }

    func finish(_ outcome: QRScanOutcome) {
        guard !finished else { return }
        finished = true
        onFinish?(outcome)
    }
}
#endif
