import SwiftUI
import TilecastCore

/// Adds a server: address entry, identity check, confirmation.
struct AddServerView: View {
    @Environment(StudioHost.self) private var host
    @Environment(\.dismiss) private var dismiss
    @State private var setup: ServerSetup?
    @State private var added = false
    @FocusState private var addressFocused: Bool

    var body: some View {
        NavigationStack {
            Group {
                if let setup {
                    form(setup)
                }
            }
            .navigationTitle("Add Server")
            .navigationBarTitleDisplayMode(.inline)
        }
        .task {
            if setup == nil {
                setup = ServerSetup(directory: host.directory, identityClient: InstallationIdentityClient())
            }
        }
        .sensoryFeedback(.success, trigger: added)
        .interactiveDismissDisabled(setup?.step == .checking)
    }

    @ViewBuilder private func form(_ setup: ServerSetup) -> some View {
        @Bindable var setup = setup
        Form {
            switch setup.step {
            case .enterAddress, .checking:
                Section {
                    TextField("Server address", text: $setup.addressText, prompt: Text(verbatim: "signage.example.org"))
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.continue)
                        .focused($addressFocused)
                        .disabled(setup.step == .checking)
                        .onSubmit { Task { await setup.check() } }
                        .accessibilityIdentifier("addServer.address")
                } footer: {
                    Text("Enter the address you use for Tilecast Studio. Plain HTTP works only for local network addresses.")
                }
                if let problem = setup.problem {
                    Section {
                        Label(problem.message, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("addServer.problem")
                    }
                }
            case .confirm(let address, let identity):
                Section("Server") {
                    LabeledContent("Organization", value: identity.organizationName)
                    LabeledContent("Address", value: address.displayString)
                }
                Section {
                    TextField("Name", text: $setup.displayName)
                        .textInputAutocapitalization(.words)
                } header: {
                    Text("Name")
                } footer: {
                    Text("Shown in the server switcher on this device.")
                }
                if address.isLocalCleartext {
                    Section {
                        Label("This connection isn’t encrypted. Use it only on a network you trust.", systemImage: "lock.open")
                            .foregroundStyle(.orange)
                    }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if case .confirm = setup.step {
                    Button("Back") { setup.edit() }
                } else {
                    Button("Cancel", role: .cancel) { dismiss() }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                switch setup.step {
                case .enterAddress:
                    Button("Continue") { Task { await setup.check() } }
                        .disabled(!setup.canCheck)
                case .checking:
                    ProgressView()
                case .confirm:
                    Button("Add") { add(setup) }
                        .accessibilityIdentifier("addServer.add")
                }
            }
        }
        .onAppear { addressFocused = true }
    }

    private func add(_ setup: ServerSetup) {
        guard let profile = setup.add() else { return }
        added = true
        dismiss()
        Task { await host.activate(profile.id) }
    }
}

extension ServerSetup.Problem {
    var message: String {
        switch self {
        case .address(let error):
            error.message
        case .identity(let error, let address):
            error.title + ". " + error.message(for: address)
        case .alreadyAdded(let existing):
            String(localized: "This Tilecast server is already added as “\(existing.displayName)”.")
        }
    }
}
