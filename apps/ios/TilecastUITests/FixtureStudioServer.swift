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
    /// The Tilecast API endpoints native media intake uses.
    let api = FixtureUploadAPI()
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
        let api = api
        listener.newConnectionHandler = { [queue] connection in
            connection.start(queue: queue)
            Self.receive(on: connection, buffer: Data(), api: api)
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

    private static func receive(on connection: NWConnection, buffer: Data, api: FixtureUploadAPI) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { data, _, complete, error in
            var buffer = buffer
            if let data { buffer.append(data) }
            if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
                let length = head.split(separator: "\r\n").lazy
                    .compactMap { line -> Int? in
                        let parts = line.split(separator: ":", maxSplits: 1)
                        guard parts.count == 2, parts[0].lowercased() == "content-length" else { return nil }
                        return Int(parts[1].trimmingCharacters(in: .whitespaces))
                    }.first ?? 0
                let body = buffer[end.upperBound...]
                if body.count >= length {
                    respond(to: head, body: Data(body.prefix(length)), on: connection, api: api)
                    return
                }
            }
            if complete || error != nil {
                connection.cancel()
            } else {
                receive(on: connection, buffer: buffer, api: api)
            }
        }
    }

    private static func respond(to head: String, body requestBody: Data, on connection: NWConnection, api: FixtureUploadAPI) {
        let lines = head.split(separator: "\r\n", omittingEmptySubsequences: false)
        let requestLine = lines.first?.split(separator: " ") ?? []
        let method = requestLine.first.map(String.init) ?? "GET"
        let target = requestLine.dropFirst().first.map(String.init) ?? "/"
        let path = target.split(separator: "?").first.map(String.init) ?? "/"
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            let parts = line.split(separator: ":", maxSplits: 1)
            if parts.count == 2 { headers[parts[0].lowercased()] = parts[1].trimmingCharacters(in: .whitespaces) }
        }

        var status = 200
        var extra: [String: String] = [:]
        var payload: Data
        var type = "text/html; charset=utf-8"
        if api.handles(path) {
            let response = api.respond(to: .init(method: method, path: path, headers: headers, body: requestBody))
            status = response.status
            extra = response.headers
            type = response.headers["Content-Type"] ?? "application/json"
            payload = response.body
        } else if path == "/api/v1/system/identity" {
            type = "application/json"
            payload = Data(identity.utf8)
        } else if path == "/__native/modal" || path.hasPrefix("/__native/modal/") {
            payload = Data(fixturePresentation.utf8)
        } else {
            payload = Data(fixtureStudio.utf8)
        }
        extra["Content-Type"] = type
        let reason = HTTPURLResponse.localizedString(forStatusCode: status)
        // A HEAD or 204 answer carries no body, but its headers stay.
        let bodyless = method == "HEAD" || status == 204
        let header = (["HTTP/1.1 \(status) \(reason)"]
            + extra.map { "\($0.key): \($0.value)" }
            + ["Content-Length: \(bodyless ? 0 : payload.count)", "Cache-Control: no-store", "Connection: close", "", ""])
            .joined(separator: "\r\n")
        connection.send(content: Data(header.utf8) + (bodyless ? Data() : payload), completion: .contentProcessed { _ in
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
        <style>
        body { font: 17px -apple-system, sans-serif; margin: 0; }
        main { padding: 16px; }
        .row { padding: 14px 0; border-bottom: 1px solid #c7c7cc; }
        /* Pinned to the bottom of the web view. If the web view ends above the
           tab bar, so does this bar. */
        #viewport-bottom { position: fixed; left: 0; right: 0; bottom: 0; height: 24px;
          background: rgba(0, 122, 255, 0.35); font-size: 12px; }
        </style>
        </head>
        <body>
        <nav id="sidebar"><a href="/">Browser sidebar</a></nav>
        <main>
        <h1 id="page"></h1>
        <p id="document"></p>
        <p id="metrics"></p>
        <p><button id="open-sheet" type="button">Open fixture sheet</button></p>
        <p><button id="drill" type="button">Open screen detail</button></p>
        <p id="opened"></p>
        <p id="ended">Ended 0</p>
        <p>
        <button id="haptic" type="button">Haptic</button>
        <button id="share" type="button">Share</button>
        <button id="share-unsafe" type="button">Share unsafe</button>
        </p>
        <p id="system-result"></p>
        <p><button id="upload-media" type="button">Upload media</button></p>
        <p id="intake"></p>
        <p><button id="ask" type="button">Delete fixture</button></p>
        <p id="chosen"></p>
        <section id="rows"></section>
        <p><button id="bottom-action" type="button">Bottom action</button></p>
        <p id="bottom-pressed"></p>
        </main>
        <div id="viewport-bottom">Viewport bottom</div>
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
        // Fleet and Media are long pages; the others are shorter than the viewport.
        const tall = new Set(["fleet", "media"]);
        const render = () => {
          const id = active();
          document.getElementById("page").textContent = location.pathname === "/fleet/screen-1" ? "Screen detail page"
            : id ? `${titles[id]} page` : "No destination";
          document.getElementById("document").textContent = `Document ${documentId}`;
          document.getElementById("rows").replaceChildren(...(tall.has(id) ? Array.from({ length: 60 }, (_, index) => {
            const row = document.createElement("div");
            row.className = "row";
            row.textContent = `Row ${index + 1}`;
            return row;
          }) : []));
          document.getElementById("metrics").textContent =
            `Viewport ${window.innerWidth}x${window.innerHeight}`;
        };
        window.addEventListener("resize", render);
        document.getElementById("bottom-action").addEventListener("click", () => {
          document.getElementById("bottom-pressed").textContent = "Bottom action pressed";
        });
        const handler = window.webkit?.messageHandlers?.tilecastNative;
        const send = (type, payload) => handler.postMessage({ version: 1, type, payload });
        // A drill-in page describes its trail, as Studio does from its breadcrumbs.
        const chrome = () => location.pathname === "/fleet/screen-1"
          ? { title: "Lobby north", back: { label: "Fleet" } } : { title: titles[active()] ?? "Fleet" };
        const publish = async () => {
          render();
          await send("navigation/state", { activeDestinationId: active(), path: location.pathname });
          await send("navigation/chrome", chrome());
        };
        document.getElementById("drill").addEventListener("click", () => {
          history.pushState(null, "", "/fleet/screen-1");
          void publish();
        });
        // A presentation is its own document with its own data, so Studio
        // refetches when one ends. The fixture just counts.
        let ended = 0;
        let intakeRequests = 0;
        window.tilecastNativeReceiver = (message) => {
          if (message?.type === "system/media-intake-completed") {
            const { outcome, uploadedCount } = message.payload;
            document.getElementById("intake").textContent = `Intake ${outcome} ${uploadedCount}`;
            return true;
          }
          if (message?.type === "presentation/ended") {
            document.getElementById("ended").textContent = `Ended ${++ended}`;
            return true;
          }
          if (message?.type === "alert/action") {
            document.getElementById("chosen").textContent = `Chose ${message.payload.actionId}`;
            return true;
          }
          if (message?.type === "navigation/back") {
            history.pushState(null, "", "/fleet");
            void publish();
            return true;
          }
          const path = message?.type === "navigation/request" ? paths[message.payload.destinationId]
            : message?.type === "navigation/open-path" ? message.payload.path : undefined;
          if (!path) return false;
          if (location.pathname !== path) history.pushState(null, "", path);
          void publish();
          return true;
        };
        const result = (text) => { document.getElementById("system-result").textContent = text; };
        document.getElementById("haptic").addEventListener("click", async () => {
          const reply = handler && await send("system/haptic", { feedback: "success" });
          result(reply?.ok ? "Haptic ok" : "Haptic unavailable");
        });
        document.getElementById("share").addEventListener("click", async () => {
          const reply = handler && await send("system/share", {
            title: "Fixture link", text: "A page worth sharing", url: "https://example.org/fixture",
          });
          result(reply?.ok ? "Share ok" : `Share ${reply?.error?.code ?? "unavailable"}`);
        });
        document.getElementById("share-unsafe").addEventListener("click", async () => {
          const reply = handler && await send("system/share", { url: "javascript:alert(1)" });
          result(reply?.ok ? "Share ok" : `Share ${reply?.error?.code ?? "unavailable"}`);
        });
        // Studio decides when to offer native intake. Its own uploader is the
        // permanent path, so a host that cannot begin gets the web input.
        document.getElementById("upload-media").addEventListener("click", async () => {
          const intake = document.getElementById("intake");
          const status = handler && await send("system/media-intake-status", {});
          if (status?.ok && status.payload.available === true) {
            const reply = await send("system/media-intake", {
              requestId: `mi-${documentId}-${++intakeRequests}`, accept: ["image", "video"], multiple: true,
            });
            intake.textContent = reply?.ok ? "Intake started" : "Web uploader";
          } else {
            intake.textContent = "Web uploader";
          }
        });
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
          await send("frontend/ready", {
            capabilities: { nativePresentations: true, nativeAlerts: true, nativeMediaIntake: true, deepLinks: true },
          });
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
        <p><button id="share" type="button">Share from sheet</button></p>
        <p id="system-result"></p>
        <p><button id="ask" type="button">Ask from sheet</button></p>
        <p><button id="grow" type="button">Grow sheet</button></p>
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
        document.getElementById("share").addEventListener("click", async () => {
          const reply = await send("system/share", { title: "From the sheet", url: "https://example.org/sheet" });
          text("system-result", reply?.ok ? "Share ok" : `Share ${reply?.error?.code ?? "unavailable"}`);
        });
        // A dialog inside a compact presentation asks the sheet for the full
        // height, as Studio's dialog primitives do.
        document.getElementById("grow").addEventListener("click", async () => {
          if (!current) return;
          await send("presentation/update", { presentationId: current, size: "full" });
          text("action", "Grew");
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
