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
///
/// Below the presentation root it serves `fixturePresentation`, Studio's
/// presentation frontend as `apps/dashboard/src/native-presentation` runs
/// it. Its route and its header are made up too.
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
        let (type, body) = if path == "/api/v1/system/identity" {
            ("application/json", identity)
        } else if path == "/__native/modal" || path.hasPrefix("/__native/modal/") {
            ("text/html; charset=utf-8", fixturePresentation)
        } else {
            ("text/html; charset=utf-8", fixtureStudio)
        }
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
        <p><button id="open-sheet" type="button">Open fixture sheet</button></p>
        <p id="opened"></p>
        <p id="ended">Ended 0</p>
        <p><button id="ask" type="button">Delete fixture</button></p>
        <p id="chosen"></p>
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
        // A presentation is its own document with its own data, so Studio
        // refetches when one ends. The fixture just counts.
        let ended = 0;
        window.tilecastNativeReceiver = (message) => {
          if (message?.type === "presentation/ended") {
            document.getElementById("ended").textContent = `Ended ${++ended}`;
            return true;
          }
          if (message?.type === "alert/action") {
            document.getElementById("chosen").textContent = `Chose ${message.payload.actionId}`;
            return true;
          }
          const path = message?.type === "navigation/request" ? paths[message.payload.destinationId]
            : message?.type === "navigation/open-path" ? message.payload.path : undefined;
          if (!path) return false;
          if (location.pathname !== path) history.pushState(null, "", path);
          void publish();
          return true;
        };
        // Studio's confirmations use a native alert when the app offers one.
        document.getElementById("ask").addEventListener("click", async () => {
          await send("alert/present", {
            alertId: "a-main-1", title: "Delete this fixture?", message: "This cannot be undone.",
            actions: [
              { id: "cancel", label: "Cancel", role: "cancel" },
              { id: "confirm", label: "Delete", role: "destructive" },
            ],
          });
        });
        let presentations = 0;
        document.getElementById("open-sheet").addEventListener("click", async () => {
          const reply = handler && await send("presentation/open", {
            presentationId: `p-${documentId}-${++presentations}`,
            path: "/__native/modal/fixture/sheet",
            title: "Fixture Sheet",
            subtitle: "Made up",
            size: "compact",
          });
          // Without a native presentation, Studio shows its own dialog.
          document.getElementById("opened").textContent = reply?.ok ? "Opened natively" : "Opened in page";
        });
        render();
        (async () => {
          if (!handler) return;
          const config = await send("config/get", {});
          if (config?.payload?.capabilities?.nativeNavigation !== true) return;
          await send("frontend/ready", { capabilities: { nativePresentations: true, nativeAlerts: true } });
          const reply = await send("navigation/catalog", catalog);
          if (reply.ok) document.getElementById("sidebar").hidden = true;
          await publish();
        })();
        </script>
        </body>
        </html>
        """

    static let fixturePresentation = """
        <!doctype html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Fixture Presentation</title>
        <style>body { font: 17px -apple-system, sans-serif; margin: 16px; }</style>
        </head>
        <body>
        <p id="state">Idle</p>
        <p id="document"></p>
        <p id="action"></p>
        <p><button id="close" type="button">Close from page</button></p>
        <p><button id="leave" type="button">Go to Layouts</button></p>
        <p><button id="ask" type="button">Ask from sheet</button></p>
        <p id="chosen"></p>
        <script>
        const documentId = Math.random().toString(36).slice(2, 10);
        const handler = window.webkit?.messageHandlers?.tilecastNative;
        const send = (type, payload) => handler.postMessage({ version: 1, type, payload });
        let current = null;
        let shown = 0;
        const text = (id, value) => { document.getElementById(id).textContent = value; };
        text("document", `Presentation document ${documentId}`);
        window.tilecastNativeReceiver = (message) => {
          const payload = message?.payload ?? {};
          switch (message?.type) {
            case "presentation/show":
              current = payload.presentationId;
              history.replaceState(null, "", payload.path);
              text("state", `Showing ${location.pathname.slice("/__native/modal/".length)}, time ${++shown}`);
              text("action", "");
              void send("presentation/update", {
                presentationId: current,
                header: {
                  title: "Fixture Sheet",
                  subtitle: "Made up",
                  actions: [{ id: "ping", label: "Ping", icon: "a-token-no-app-knows" }],
                  menuLabel: "Fixture menu",
                  menu: [{ id: "about", label: "About the fixture" }],
                },
              });
              return true;
            case "presentation/action":
              if (payload.presentationId !== current) return false;
              text("action", `Action ${payload.actionId}`);
              return true;
            case "alert/action":
              text("chosen", `Sheet chose ${payload.actionId}`);
              return true;
            case "presentation/dismissed":
              if (payload.presentationId === current) current = null;
              history.replaceState(null, "", "/__native/modal");
              text("state", "Idle");
              return true;
            default:
              return false;
          }
        };
        document.getElementById("close").addEventListener("click", () => {
          if (current) void send("presentation/close", { presentationId: current });
        });
        document.getElementById("ask").addEventListener("click", () => {
          void send("alert/present", {
            alertId: "a-sheet-1", title: "Discard this fixture?",
            actions: [{ id: "keep", label: "Keep", role: "cancel" }, { id: "discard", label: "Discard", role: "destructive" }],
          });
        });
        document.getElementById("leave").addEventListener("click", () => {
          if (current) void send("presentation/navigate", { presentationId: current, path: "/layouts" });
        });
        (async () => {
          if (!handler) return;
          const config = await send("config/get", {});
          if (config?.payload?.context !== "presentation") return;
          await send("frontend/ready", { capabilities: { nativePresentations: true, nativeAlerts: true } });
          await send("presentation/ready", {});
        })();
        </script>
        </body>
        </html>
        """
}
