import Foundation
import Network

/// A loopback HTTP server that stands in for a Tilecast installation in UI
/// tests, so they need no real server and no internet access.
///
/// It answers the identity document and serves `fixtureStudio` for every
/// other path, the way the real server serves Studio's single-page app. The
/// fixture speaks Studio's side of the native bridge exactly as
/// `apps/dashboard/src/native-host` does: it negotiates, sends a catalog of
/// made-up destinations, and navigates with the History API when the app
/// asks. The app sees only the protocol, so the fixture proves the native
/// shell works for destinations it has never heard of.
final class FixtureStudioServer: @unchecked Sendable {
    let port: UInt16
    private let listener: NWListener
    private let queue = DispatchQueue(label: "FixtureStudioServer")

    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
        }
        listener.newConnectionHandler = { [queue] connection in
            connection.start(queue: queue)
            Self.receive(on: connection, buffer: Data())
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 10) == .success, let port = listener.port?.rawValue else {
            listener.cancel()
            throw CocoaError(.fileReadUnknown)
        }
        self.port = port
    }

    var address: String { "http://127.0.0.1:\(port)" }

    func stop() {
        listener.cancel()
    }

    private static func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, complete, error in
            var buffer = buffer
            if let data { buffer.append(data) }
            if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
                respond(to: head, on: connection)
            } else if complete || error != nil {
                connection.cancel()
            } else {
                receive(on: connection, buffer: buffer)
            }
        }
    }

    private static func respond(to head: String, on connection: NWConnection) {
        let target = head.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
        let path = target.split(separator: "?").first.map(String.init) ?? "/"
        let (type, body) = path == "/api/v1/system/identity"
            ? ("application/json", identity)
            : ("text/html; charset=utf-8", fixtureStudio)
        let payload = Data(body.utf8)
        let header = [
            "HTTP/1.1 200 OK",
            "Content-Type: \(type)",
            "Content-Length: \(payload.count)",
            "Cache-Control: no-store",
            "Connection: close",
            "", "",
        ].joined(separator: "\r\n")
        connection.send(content: Data(header.utf8) + payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    static let identity = """
        {"data":{"product":"tilecast","apiVersion":"v1",\
        "installationId":"8c7d4a52-6a1e-4c1a-9f2b-2f6f0e6d7a10","organizationName":"Fixture School"}}
        """

    static let fixtureStudio = """
        <!doctype html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Fixture Studio</title>
        <style>body { font: 17px -apple-system, sans-serif; margin: 16px; }</style>
        </head>
        <body>
        <nav id="sidebar"><a href="/">Browser sidebar</a></nav>
        <h1 id="page"></h1>
        <p id="document"></p>
        <script>
        const documentId = Math.random().toString(36).slice(2, 10);
        const paths = {
          overview: "/", fleet: "/fleet", media: "/media",
          layouts: "/layouts", "room-bookings": "/room-bookings", settings: "/settings",
        };
        const titles = {
          overview: "Overview", fleet: "Fleet", media: "Media",
          layouts: "Layouts", "room-bookings": "Room Bookings", settings: "Settings",
        };
        const catalog = { groups: [
          { id: "home", items: [{ id: "overview", title: "Overview", icon: "home", mobilePlacement: "primary" }] },
          { id: "work", title: "Work", items: [
            { id: "fleet", title: "Fleet", icon: "screens", mobilePlacement: "primary" },
            { id: "media", title: "Media", icon: "media", mobilePlacement: "primary" },
            { id: "layouts", title: "Layouts", icon: "layouts" },
            { id: "room-bookings", title: "Room Bookings", icon: "door-calendar" },
          ] },
          { id: "secondary", items: [{ id: "settings", title: "Settings", icon: "settings" }] },
        ] };
        const active = () => Object.keys(paths).find((id) => paths[id] === location.pathname) ?? null;
        const render = () => {
          const id = active();
          document.getElementById("page").textContent = id ? `${titles[id]} page` : "No destination";
          document.getElementById("document").textContent = `Document ${documentId}`;
        };
        const handler = window.webkit?.messageHandlers?.tilecastNative;
        const send = (type, payload) => handler.postMessage({ version: 1, type, payload });
        const publish = () => {
          render();
          return send("navigation/state", { activeDestinationId: active(), path: location.pathname });
        };
        window.tilecastNativeReceiver = (message) => {
          const path = message?.type === "navigation/request" ? paths[message.payload.destinationId] : undefined;
          if (!path) return false;
          if (location.pathname !== path) history.pushState(null, "", path);
          void publish();
          return true;
        };
        render();
        (async () => {
          if (!handler) return;
          const config = await send("config/get", {});
          if (config?.payload?.capabilities?.nativeNavigation !== true) return;
          await send("frontend/ready", {});
          const reply = await send("navigation/catalog", catalog);
          if (reply.ok) document.getElementById("sidebar").hidden = true;
          await publish();
        })();
        </script>
        </body>
        </html>
        """
}
