#!/usr/bin/env python3
"""Adversarial tests of tilecast-web-renderer-wpe (threat review §9-§14).

Runs the real helper binary as an unprivileged account against local
fixture servers on 127.0.0.1:80 and :443 (so the default-port rule holds).
Pages report what they can see to the fixture server, which is the
observer; nothing here inspects source strings.

    security_test.py --helper PATH [--keep]

Needs root (to bind ports 80/443 and to start the helper as another UID),
gst-launch-1.0 and openssl. Set WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 in
containers without unprivileged user namespaces.
"""

import argparse
import http.server
import os
import secrets
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rwclient  # noqa: E402

HELPER_UID = 4242
OTHER_UID = 4243
REPORTS = []
REPORTS_LOCK = threading.Lock()
REQUESTS = []

PAGES = {
    "/bridge.html": """<script>
      fetch('/report?bridge=' + typeof globalThis.tilecastRuntimeHost + '&webkit=' + typeof globalThis.webkit
        + '&handlers=' + typeof (globalThis.webkit && globalThis.webkit.messageHandlers)
        + '&tilecasthost=' + typeof globalThis.__tilecastHost);
    </script>""",
    "/landed.html": "<script>fetch('/report?landed=' + location.hostname);</script>",
    "/nav-outside.html": "<script>setTimeout(() => { location.href = 'http://localhost/landed.html'; }, 300);</script>",
    "/nav-inside.html": "<script>setTimeout(() => { location.href = '/landed.html'; }, 300);</script>",
    "/schemes.html": """<body><script>
      const results = [];
      for (const target of ['file:///etc/passwd', 'tilecast://runtime/index.html',
          'tcmedia://cap/0000000000000000000000000000000000000000000000000000000000000000',
          'tcweb://cap/0000000000000000000000000000000000000000000000000000000000000000']) {
        const f = document.createElement('iframe'); f.src = target; document.body.appendChild(f);
      }
      let popup = 'error';
      try { popup = String(window.open('http://127.0.0.1/landed.html')); } catch (e) { popup = 'threw'; }
      try { location.href = 'mailto:someone@example.org'; } catch (e) {}
      try { location.href = 'file:///etc/passwd'; } catch (e) {}
      setTimeout(() => {
        let frames = 0;
        for (const f of document.querySelectorAll('iframe')) {
          try { if (f.contentDocument && f.contentDocument.body && f.contentDocument.body.innerText.length) frames++; }
          catch (e) {}
        }
        fetch('/report?schemes=still-here&popup=' + popup + '&readable=' + frames);
      }, 2000);
    </script></body>""",
    "/download.html": """<body><script>
      const a = document.createElement('a'); a.href = '/file.bin'; a.download = 'x.bin';
      document.body.appendChild(a); a.click();
      setTimeout(() => fetch('/report?download=still-here'), 1500);
    </script></body>""",
    "/permissions.html": """<script>
      const send = (key, value) => fetch('/report?' + key + '=' + encodeURIComponent(value));
      send('dialogs', [String(alert('x')), String(confirm('x')), String(prompt('x'))].join(','));
      if (navigator.geolocation) navigator.geolocation.getCurrentPosition(
        () => send('geo', 'granted'), () => send('geo', 'denied'));
      else send('geo', 'absent');
      (typeof Notification === 'undefined' ? Promise.resolve('absent') : Notification.requestPermission())
        .then((p) => send('notify', p), () => send('notify', 'rejected'));
      (navigator.mediaDevices && navigator.mediaDevices.getUserMedia
        ? navigator.mediaDevices.getUserMedia({audio: true, video: true}).then(() => 'granted', () => 'denied')
        : Promise.resolve('absent')).then((m) => send('media', m));
      (navigator.clipboard ? navigator.clipboard.readText().then(() => 'granted', () => 'denied')
        : Promise.resolve('absent')).then((c) => send('clipboard', c));
    </script>""",
    "/storage-set.html": "<script>localStorage.setItem('tc', 'kept'); fetch('/report?storage=set');</script>",
    "/storage-check.html": "<script>fetch('/report?storage=' + (localStorage.getItem('tc') || 'none'));</script>",
    "/still.html": "<body style='background:#08f'><h1>still</h1></body>",
}


def report(**values):
    with REPORTS_LOCK:
        REPORTS.append(values)


def wait_report(key, timeout=20, value=None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with REPORTS_LOCK:
            for index, entry in enumerate(REPORTS):
                if key in entry and (value is None or entry[key] == value):
                    return REPORTS.pop(index)
        time.sleep(0.1)
    raise TimeoutError(f"no report {key} (have {REPORTS})")


def no_report(key, seconds=3):
    time.sleep(seconds)
    with REPORTS_LOCK:
        assert not any(key in entry for entry in REPORTS), f"unexpected report {key}: {REPORTS}"


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):  # noqa: N802
        url = urllib.parse.urlsplit(self.path)
        REQUESTS.append((self.headers.get("Host", ""), url.path, self.headers.get("Cookie", "")))
        if url.path == "/report":
            report(**dict(urllib.parse.parse_qsl(url.query)))
            return self.reply(204, b"")
        if url.path == "/redirect-inside":
            return self.redirect("/landed.html")
        if url.path == "/redirect-outside":
            return self.redirect("http://localhost/landed.html")
        if url.path == "/file.bin":
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", "attachment; filename=x.bin")
            self.end_headers()
            self.wfile.write(b"\0" * 1024)
            return None
        if url.path == "/cookie-set.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Set-Cookie", "tc=1; Max-Age=3600; Path=/")
            self.end_headers()
            self.wfile.write(b"<script>fetch('/report?cookie=set');</script>")
            return None
        if url.path == "/cookie-check.html":
            report(cookie_seen=self.headers.get("Cookie", "") or "none")
            return self.reply(200, b"<p>checked</p>")
        if url.path == "/missing.html":
            return self.reply(404, b"<p>missing</p>")
        body = PAGES.get(url.path)
        if body is None:
            return self.reply(404, b"")
        return self.reply(200, body.encode())

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def reply(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


def serve(port, tls_context=None):
    server = Server(("127.0.0.1", port), Handler)
    if tls_context:
        server.socket = tls_context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class Helper:
    def __init__(self, binary, root):
        self.binary = binary
        self.root = root
        self.control = os.path.join(root, "run", "control.sock")
        self.frames = os.path.join(root, "run", "frames")
        self.process = None

    def start(self):
        env = dict(os.environ, HOME=os.path.join(self.root, "home"), XDG_RUNTIME_DIR=os.path.join(self.root, "xdg"))
        self.process = subprocess.Popen(
            ["setpriv", f"--reuid={HELPER_UID}", f"--regid={HELPER_UID}", "--clear-groups", self.binary,
             f"--control-socket={self.control}", f"--frames-dir={self.frames}",
             f"--data-dir={self.root}/data", f"--cache-dir={self.root}/cache", "--client-uid=0"],
            env=env, stdout=open(os.path.join(self.root, "helper.log"), "ab"), stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 15
        while not os.path.exists(self.control):
            if self.process.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("helper did not start: " + open(os.path.join(self.root, "helper.log")).read())
            time.sleep(0.1)

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            self.process.wait(10)

    def client(self):
        client = rwclient.Client(self.control)
        client.hello()
        return client


def live_web_processes(parent):
    """Live WPEWebProcess children of the helper, oldest first."""
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            stat = open(f"/proc/{entry}/stat").read()
        except OSError:
            continue
        name = stat[stat.index("(") + 1:stat.rindex(")")]
        fields = stat[stat.rindex(")") + 2:].split()
        if name.startswith("WPEWebProcess") and fields[0] != "Z" and int(fields[1]) == parent:
            found.append(int(entry))
    return sorted(found)


def check(name, condition, detail=""):
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"ok   {name}")


def created(client, surface_id, content, **kw):
    reply = client.create(surface_id, content, **kw)
    check(f"{surface_id} created", reply["type"] == "created", reply)
    return reply["capability"]


LOCAL = ["127.0.0.1"]


def run(helper, root):
    client = helper.client()

    # §10: no bridge, no handler object.
    capability = created(client, "bridge", rwclient.page("http://127.0.0.1/bridge.html", LOCAL))
    entry = wait_report("bridge")
    check("remote page has no tilecastRuntimeHost", entry["bridge"] == "undefined", entry)
    check("remote page has no webkit.messageHandlers", entry["webkit"] == "undefined"
          and entry["handlers"] == "undefined" and entry["tilecasthost"] == "undefined", entry)
    client.wait_event("bridge", {"loaded"})
    client.wait_event("bridge", {"stream-ready"})
    check("frames flow on the capability", rwclient.frames_flow(helper.frames, capability))
    client.destroy("bridge")
    time.sleep(0.5)
    check("destroy removes the frame socket", not os.path.exists(os.path.join(helper.frames, capability + ".sock")))
    check("use after destroy has no stream", not rwclient.frames_flow(helper.frames, capability, timeout=5))
    check("a guessed capability has no stream", not rwclient.frames_flow(helper.frames, secrets.token_hex(32), timeout=5))

    # §9: navigation and redirects.
    created(client, "nav-in", rwclient.page("http://127.0.0.1/nav-inside.html", LOCAL))
    check("navigation inside the allowlist", wait_report("landed")["landed"] == "127.0.0.1")
    client.destroy("nav-in")
    created(client, "nav-out", rwclient.page("http://127.0.0.1/nav-outside.html", LOCAL))
    event = client.wait_event("nav-out", {"navigation-blocked", "failed"})
    check("navigation outside the allowlist is blocked", event.get("code") == "blocked_navigation", event)
    no_report("landed")
    client.destroy("nav-out")
    created(client, "redir-in", rwclient.page("http://127.0.0.1/redirect-inside", LOCAL))
    check("redirect inside the allowlist", wait_report("landed")["landed"] == "127.0.0.1")
    client.destroy("redir-in")
    created(client, "redir-out", rwclient.page("http://127.0.0.1/redirect-outside", LOCAL))
    event = client.wait_event("redir-out", {"navigation-blocked", "failed"})
    check("redirect outside the allowlist is blocked", event.get("code") == "blocked_navigation", event)
    no_report("landed")
    client.destroy("redir-out")
    created(client, "initial-out", rwclient.page("http://localhost/landed.html", LOCAL))
    event = client.wait_event("initial-out", {"navigation-blocked"})
    check("initial URL outside the allowlist is blocked", event.get("code") == "blocked_navigation", event)
    client.destroy("initial-out")
    created(client, "http-404", rwclient.page("http://127.0.0.1/missing.html", LOCAL))
    event = client.wait_event("http-404", {"failed"})
    check("main-frame HTTP error fails the surface", event.get("code") == "http_error", event)
    client.destroy("http-404")

    # §9: schemes, popups, external protocols.
    created(client, "schemes", rwclient.page("http://127.0.0.1/schemes.html", LOCAL))
    entry = wait_report("schemes")
    check("local and custom schemes refused, page stays", entry["schemes"] == "still-here", entry)
    check("window.open returns no window", entry["popup"] == "null", entry)
    check("no local document is readable in a frame", entry["readable"] == "0", entry)
    client.destroy("schemes")

    # §9: downloads.
    before = sorted(os.listdir(root))
    created(client, "download", rwclient.page("http://127.0.0.1/download.html", LOCAL))
    check("download does not replace the page", wait_report("download")["download"] == "still-here")
    downloaded = subprocess.run(["find", root, "-name", "x.bin*"], capture_output=True, text=True).stdout.strip()
    check("no downloaded file anywhere", downloaded == "", downloaded)
    check("no new top-level entries", sorted(os.listdir(root)) == before)
    client.destroy("download")

    # §9: permissions and dialogs.
    created(client, "perm", rwclient.page("http://127.0.0.1/permissions.html", LOCAL))
    entry = wait_report("dialogs")
    check("dialogs close without an answer", entry["dialogs"] == "undefined,false,null", entry)
    # A permission API that never settles grants nothing; one that settles
    # must not say "granted".
    for key in ("geo", "notify", "media", "clipboard"):
        try:
            value = wait_report(key, timeout=8)[key]
        except TimeoutError:
            value = "unsettled"
        check(f"{key} permission not granted", value != "granted", value)
    client.destroy("perm")

    # §9: TLS fails closed.
    created(client, "tls", rwclient.page("https://127.0.0.1/still.html", LOCAL))
    event = client.wait_event("tls", {"failed"})
    check("an untrusted certificate fails the surface", event.get("code") == "tls_failure", event)
    client.destroy("tls")

    # §8: data profiles.
    created(client, "c1", rwclient.page("http://127.0.0.1/cookie-set.html", LOCAL, cookies="first_party"))
    wait_report("cookie")
    client.wait_event("c1", {"loaded"})
    client.destroy("c1")
    created(client, "c2", rwclient.page("http://127.0.0.1/cookie-check.html", LOCAL, cookies="first_party"))
    check("first_party profile keeps its cookie", wait_report("cookie_seen")["cookie_seen"] == "tc=1")
    client.destroy("c2")
    created(client, "c3", rwclient.page("http://127.0.0.1/cookie-check.html", LOCAL, cookies="first_and_third_party"))
    check("profiles do not share cookies", wait_report("cookie_seen")["cookie_seen"] == "none")
    client.destroy("c3")
    created(client, "d1", rwclient.page("http://127.0.0.1/cookie-set.html", LOCAL, cookies="disabled"))
    wait_report("cookie")
    client.wait_event("d1", {"loaded"})
    client.send({"type": "reload", "surfaceId": "d1"})
    client.destroy("d1")
    created(client, "d2", rwclient.page("http://127.0.0.1/cookie-check.html", LOCAL, cookies="disabled"))
    check("disabled cookies are never stored", wait_report("cookie_seen")["cookie_seen"] == "none")
    client.destroy("d2")
    created(client, "s1", rwclient.page("http://127.0.0.1/storage-set.html", LOCAL, cookies="disabled"))
    wait_report("storage", value="set")
    client.destroy("s1")
    created(client, "s2", rwclient.page("http://127.0.0.1/storage-check.html", LOCAL, cookies="disabled"))
    check("disabled policy keeps no local storage", wait_report("storage")["storage"] == "none")
    client.destroy("s2")
    created(client, "s3", rwclient.page("http://127.0.0.1/storage-set.html", LOCAL))
    wait_report("storage", value="set")
    client.destroy("s3")
    created(client, "s4", rwclient.page("http://127.0.0.1/storage-check.html", LOCAL))
    check("first_party profile keeps local storage", wait_report("storage")["storage"] == "kept")
    client.destroy("s4")
    check("clear-data succeeds", client.clear("c-1"))
    created(client, "c5", rwclient.page("http://127.0.0.1/cookie-check.html", LOCAL))
    check("clear-data removes cookies", wait_report("cookie_seen")["cookie_seen"] == "none")
    client.destroy("c5")
    created(client, "s5", rwclient.page("http://127.0.0.1/storage-check.html", LOCAL))
    check("clear-data removes local storage", wait_report("storage")["storage"] == "none")
    client.destroy("s5")
    check("clear-data is idempotent", client.clear("c-2") and client.clear("c-3"))

    # §6.1: bounds.
    for index in range(4):
        created(client, f"b{index}", rwclient.page("http://127.0.0.1/still.html", LOCAL), width=960, height=540)
    reply = client.create("b4", rwclient.page("http://127.0.0.1/still.html", LOCAL), width=320, height=240)
    check("a fifth surface is refused", reply == {"type": "rejected", "surfaceId": "b4", "code": "limit_exceeded"}, reply)
    for index in range(4):
        client.destroy(f"b{index}")
    created(client, "big", rwclient.page("http://127.0.0.1/still.html", LOCAL), width=3840, height=2160)
    reply = client.create("big2", rwclient.page("http://127.0.0.1/still.html", LOCAL), width=320, height=240)
    check("the pixel budget is enforced", reply.get("code") == "limit_exceeded", reply)
    client.destroy("big")

    # §13, §15: a page process crash fails its surface, never the helper.
    # WebKit keeps a prewarmed spare process and has no public view-to-PID
    # mapping, so every live web process is killed.
    created(client, "crash-a", rwclient.page("http://127.0.0.1/still.html", LOCAL))
    created(client, "crash-b", rwclient.page("http://127.0.0.1/still.html", LOCAL))
    client.wait_event("crash-a", {"loaded"})
    client.wait_event("crash-b", {"loaded"})
    processes = live_web_processes(helper.process.pid)
    check("each surface has a web process", len(processes) >= 2, processes)
    for pid in processes:
        os.kill(pid, signal.SIGKILL)
    for name in ("crash-a", "crash-b"):
        event = client.wait_event(name, {"failed"}, timeout=10)
        check(f"{name} fails with renderer_crash", event.get("code") == "renderer_crash", event)
    check("the helper survives its page processes", helper.process.poll() is None)
    client.destroy("crash-a")
    client.destroy("crash-b")
    created(client, "after-crash", rwclient.page("http://127.0.0.1/still.html", LOCAL))
    client.wait_event("after-crash", {"loaded"})
    print("ok   a new surface loads after the crash")
    client.destroy("after-crash")

    # §6: protocol violations close the connection; the helper survives.
    client.send_raw(b"x" * 16)
    try:
        client.recv()
        closed = False
    except (rwclient.Closed, ConnectionError):
        closed = True
    check("a malformed frame closes the connection", closed)
    client = helper.client()
    client.sock.sendall((1 << 20).to_bytes(4, "big"))
    try:
        client.recv()
        closed = False
    except (rwclient.Closed, ConnectionError):
        closed = True
    check("an oversized frame closes the connection", closed)
    client = helper.client()
    client.send({"type": "create", "surfaceId": "h", "width": 640, "height": 360, "muted": True, "visible": True,
                 "content": rwclient.page("http://127.0.0.1/still.html", [f"h{i}.example" for i in range(5000)])})
    try:
        client.recv()
        closed = False
    except (rwclient.Closed, ConnectionError):
        closed = True
    check("a huge allowlist closes the connection", closed)
    client = helper.client()
    client.send({"type": "evaluate", "surfaceId": "x", "script": "1"})
    try:
        client.recv()
        closed = False
    except (rwclient.Closed, ConnectionError):
        closed = True
    check("an unknown request closes the connection", closed)

    # §5: two layers refuse another account: the socket mode, then the
    # helper's SO_PEERCRED check for an account that is in the group.
    probe = ("import socket,struct,sys\n"
             "s=socket.socket(socket.AF_UNIX)\n"
             f"try: s.connect({helper.control!r})\n"
             "except PermissionError: sys.exit(3)\n"
             "p=b'{\"type\":\"hello\",\"version\":1}';s.sendall(struct.pack('>I',len(p))+p)\n"
             "s.settimeout(5)\n"
             "try: sys.exit(0 if s.recv(4)==b'' else 1)\n"
             "except ConnectionResetError: sys.exit(0)")
    outside = subprocess.run(["setpriv", f"--reuid={OTHER_UID}", f"--regid={OTHER_UID}", "--clear-groups",
                              sys.executable, "-c", probe], capture_output=True, text=True)
    check("the socket mode refuses another account", outside.returncode == 3, outside.stderr)
    grouped = subprocess.run(["setpriv", f"--reuid={OTHER_UID}", f"--regid={HELPER_UID}", "--clear-groups",
                              sys.executable, "-c", probe], capture_output=True, text=True)
    check("the peer UID check refuses another account in the group", grouped.returncode == 0, grouped.stderr)

    # §7: a new connection revokes the old connection's capabilities.
    client = helper.client()
    capability = created(client, "old", rwclient.page("http://127.0.0.1/still.html", LOCAL))
    client.wait_event("old", {"stream-ready"})
    replacement = helper.client()
    time.sleep(0.5)
    check("a replaced connection loses its surfaces", not os.path.exists(os.path.join(helper.frames, capability + ".sock")))
    replacement.close()

    # §15: repeated create and destroy returns to the same resources.
    client = helper.client()
    # setpriv execs the helper, so the Popen PID is the helper itself.
    fds = lambda: len(os.listdir(f"/proc/{helper.process.pid}/fd"))  # noqa: E731
    created(client, "warm", rwclient.page("http://127.0.0.1/still.html", LOCAL))
    client.wait_event("warm", {"loaded"})
    client.destroy("warm")
    time.sleep(1)
    baseline = fds()
    for index in range(40):
        created(client, f"cyc{index}", rwclient.page("http://127.0.0.1/still.html", LOCAL), width=320, height=240)
        client.wait_event(f"cyc{index}", {"stream-ready"})
        client.destroy(f"cyc{index}")
    time.sleep(2)
    check("40 create/destroy cycles leak no descriptors", fds() <= baseline + 4, (baseline, fds()))
    check("no frame socket is left", [n for n in os.listdir(helper.frames) if n.endswith(".sock")] == [])
    client.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--helper", required=True)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        sys.exit("security_test.py needs root (ports 80/443 and setpriv)")
    root = tempfile.mkdtemp(prefix="tcw-", dir="/tmp")
    os.chmod(root, 0o755)
    for sub in ("run", "data", "cache", "home", "xdg"):
        os.makedirs(os.path.join(root, sub))
        os.chown(os.path.join(root, sub), HELPER_UID, HELPER_UID)
    cert = os.path.join(root, "cert.pem")
    key = os.path.join(root, "key.pem")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1",
                    "-keyout", key, "-out", cert], check=True, capture_output=True)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    servers = [serve(80), serve(443, context)]
    helper = Helper(os.path.abspath(args.helper), root)
    helper.start()
    try:
        run(helper, root)
        # §15: the helper exits cleanly and leaves no socket.
        helper.stop()
        check("the control socket is removed on exit", not os.path.exists(helper.control))
        print("security_test: all checks passed")
    except BaseException:
        print(open(os.path.join(root, "helper.log"), errors="replace").read()[-6000:], file=sys.stderr)
        raise
    finally:
        helper.stop()
        for server in servers:
            server.shutdown()
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    socket.setdefaulttimeout(30)
    main()
