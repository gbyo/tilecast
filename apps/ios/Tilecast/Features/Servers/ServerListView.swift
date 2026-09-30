import SwiftUI
import TilecastCore

/// Lists configured servers for switching, renaming, and removal.
struct ServerListView: View {
    @Environment(StudioHost.self) private var host
    @Environment(\.dismiss) private var dismiss
    @State private var addingServer = false
    @State private var renaming: ServerProfile?
    @State private var newName = ""
    @State private var removing: ServerProfile?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(host.directory.servers) { server in
                        row(server)
                    }
                } footer: {
                    Text("Each server keeps its own sign-in and website data on this device. Removing a server deletes that data.")
                        .font(.geist(.footnote))
                }
            }
            .navigationTitle("Servers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Add Server", systemImage: "plus") { addingServer = true }
                }
            }
            .sheet(isPresented: $addingServer) { AddServerView() }
            .alert("Rename Server", isPresented: renamingPresented, presenting: renaming) { server in
                TextField("Name", text: $newName)
                Button("Rename") { host.directory.rename(server.id, to: newName) }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog(
                removing.map { String(localized: "Remove \($0.displayName)?") } ?? "",
                isPresented: removingPresented,
                titleVisibility: .visible,
                presenting: removing
            ) { server in
                Button("Remove Server", role: .destructive) {
                    Task { await host.remove(server.id) }
                }
            } message: { _ in
                Text("Its website data on this device, including your sign-in, is deleted.")
            }
        }
    }

    private func row(_ server: ServerProfile) -> some View {
        Button {
            dismiss()
            Task { await host.activate(server.id) }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(server.displayName)
                        .foregroundStyle(.primary)
                    Text(server.address.displayString)
                        .font(.geist(.subheadline))
                        .foregroundStyle(.secondary)
                    if server.organizationName != server.displayName, !server.organizationName.isEmpty {
                        Text(server.organizationName)
                            .font(.geist(.footnote))
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if server.id == host.directory.activeServerID {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                        .accessibilityLabel("Current server")
                }
            }
            .contentShape(.rect)
        }
        .accessibilityAddTraits(server.id == host.directory.activeServerID ? .isSelected : [])
        .swipeActions {
            Button("Remove", systemImage: "trash", role: .destructive) { removing = server }
            Button("Rename", systemImage: "pencil") { beginRename(server) }
        }
        .contextMenu {
            Button("Rename", systemImage: "pencil") { beginRename(server) }
            Button("Remove", systemImage: "trash", role: .destructive) { removing = server }
        }
    }

    private func beginRename(_ server: ServerProfile) {
        newName = server.displayName
        renaming = server
    }

    private var renamingPresented: Binding<Bool> {
        Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    }

    private var removingPresented: Binding<Bool> {
        Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
    }
}
