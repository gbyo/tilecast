#!/usr/bin/env python3
"""Cross-language end-to-end test: a real Tilecast Server and a real tilecastd.

Drives the production pairing flow through a locally trusted HTTPS endpoint (setup, pairing session,
dashboard approval, enrollment), writes the resulting state in the legacy
Electron player's on-disk format, then checks that tilecastd:

1. imports it once (`tilecastd import-legacy`), leaving the legacy files
   untouched, and refuses a second import as already complete;
2. verifies installation identity, enrolls an Edge certificate with its own
   key, reports normal player heartbeat contact and Edge status (`/edge/nodes`);
3. deletes the credential only after the server says it was revoked.

Requirements: Go, cargo, a local PostgreSQL where the current user may
create databases. Usage: apps/edge/ci/e2e_server.py (from the repository root).
"""

import hashlib
import http.cookiejar
import json
import os
import re
import select
import shutil
import signal
import socket
import socketserver
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
EDGE = os.path.join(ROOT, "apps", "edge")
SERVER = os.path.join(ROOT, "apps", "server")
DATABASE = "tilecast_edge_e2e"
PORT = 18080
TLS_PORT = 18081
BASE = f"https://localhost:{TLS_PORT}"


class TlsForwarder(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, cert, key):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(cert, key)
        self.tls_context = context
        super().__init__(("127.0.0.1", TLS_PORT), TlsForwarderHandler)

    def get_request(self):
        connection, address = super().get_request()
        return self.tls_context.wrap_socket(connection, server_side=True), address


class TlsForwarderHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            upstream = socket.create_connection(("127.0.0.1", PORT), timeout=10)
        except OSError:
            return
        with upstream:
            self.request.settimeout(None)
            upstream.settimeout(None)
            sockets = (self.request, upstream)
            while True:
                readable, _, _ = select.select(sockets, [], [], 30)
                if not readable:
                    continue
                for source in readable:
                    try:
                        data = source.recv(65536)
                    except OSError:
                        return
                    if not data:
                        return
                    try:
                        (upstream if source is self.request else self.request).sendall(data)
                    except OSError:
                        return


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


class Client:
    def __init__(self, ca_file):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=ca_file)),
        )
        self.csrf = None

    def call(self, method, path, body=None, headers=None, expect=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(BASE + path, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        if self.csrf and method not in ("GET", "HEAD"):
            request.add_header("X-CSRF-Token", self.csrf)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with self.opener.open(request, timeout=10) as response:
                status, payload = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, payload = error.code, error.read()
        except (urllib.error.URLError, OSError):
            status, payload = 0, b""
        if expect is not None and status != expect:
            # Never echo a credential or token, even from a throwaway server.
            text = re.sub(r"(tc_device_|Token\":\")[A-Za-z0-9._-]+", r"\1[redacted]", payload[:400].decode(errors="replace"))
            raise AssertionError(f"{method} {path}: {status} {text}")
        return status, (json.loads(payload) if payload else None)


def wait_for(predicate, what, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.5)
    raise AssertionError(f"timed out waiting for {what}")


def tree(root):
    out = {}
    for base, _, files in os.walk(root):
        for name in files:
            path = os.path.join(base, name)
            with open(path, "rb") as handle:
                out[os.path.relpath(path, root)] = hashlib.sha256(handle.read()).hexdigest()
    return out


def main():
    work = tempfile.mkdtemp(prefix="tilecast-edge-e2e-")
    processes = []
    proxy = None
    try:
        cert, key = os.path.join(work, "test-ca.pem"), os.path.join(work, "test-key.pem")
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "1",
            "-keyout", key, "-out", cert, "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost", "-addext", "basicConstraints=critical,CA:FALSE",
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.environ["SSL_CERT_FILE"] = cert
        proxy = TlsForwarder(cert, key)
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        run("dropdb", "--if-exists", DATABASE)
        run("createdb", DATABASE)
        server_bin = os.path.join(work, "tilecast")
        run("go", "build", "-o", server_bin, "./cmd/tilecast", cwd=SERVER)
        run("cargo", "build", "-q", "-p", "tilecastd", "-p", "tilecastctl", cwd=EDGE)
        target = os.path.join(EDGE, "target", "debug")
        tilecastd, tilecastctl = os.path.join(target, "tilecastd"), os.path.join(target, "tilecastctl")

        # This test uploads no media, so when FFmpeg is not installed the
        # server's startup probe (`<tool> -version`) is answered by a stub
        # that refuses every other invocation.
        tools = {}
        for tool in ("ffmpeg", "ffprobe"):
            found = shutil.which(tool)
            if not found:
                found = os.path.join(work, tool)
                with open(found, "w") as handle:
                    handle.write(f'#!/bin/sh\n[ "$1" = "-version" ] && echo "{tool} version e2e-stub" && exit 0\nexit 1\n')
                os.chmod(found, 0o755)
            tools[tool] = found

        server_log = open(os.path.join(work, "server.log"), "w")
        env = dict(
            os.environ,
            TILECAST_DATABASE_URL=f"postgres://localhost:5432/{DATABASE}?sslmode=disable",
            TILECAST_HTTP_ADDR=f"127.0.0.1:{PORT}",
            TILECAST_PUBLIC_URL=BASE,
            TILECAST_MDNS_ENABLED="false",
            TILECAST_EDGE_ENABLED="true",
            TILECAST_EDGE_ROOT=os.path.join(work, "server-edge"),
            TILECAST_MEDIA_ROOT=os.path.join(work, "server-media"),
            TILECAST_UPDATE_ROOT=os.path.join(work, "server-updates"),
            TILECAST_BACKUP_ROOT=os.path.join(work, "server-backups"),
            TILECAST_FFMPEG_PATH=tools["ffmpeg"],
            TILECAST_FFPROBE_PATH=tools["ffprobe"],
        )
        server_process = subprocess.Popen([server_bin], env=env, stdout=server_log, stderr=subprocess.STDOUT)
        processes.append(server_process)
        client = Client(cert)
        wait_for(lambda: client.call("GET", "/readyz")[0] == 200, "server readiness")

        _, setup = client.call(
            "POST",
            "/api/v1/auth/setup",
            {"organizationName": "Greenwood Library", "ownerName": "E2E Owner", "username": "owner",
             "password": "correct horse battery staple"},
            expect=201,
        )
        client.csrf = setup["data"]["csrfToken"]
        _, identity = client.call("GET", "/api/v1/system/identity", expect=200)
        installation_id = identity["data"]["installationId"]

        # The legacy player's pairing flow.
        player = Client(cert)
        node_id = str(uuid.uuid4())
        metadata = {"playerInstallationId": node_id, "platform": "linux", "manufacturer": "e2e", "model": "Linux x64",
                    "androidVersion": "6.8.0-e2e", "playerVersion": "0.1.0", "screenWidth": 1920, "screenHeight": 1080,
                    "density": 1, "locale": "en-US", "timezone": "UTC"}
        _, created = player.call("POST", "/api/v1/player/pairing-sessions",
                                 {"installationId": installation_id, "metadata": metadata}, expect=201)
        session = created["data"]
        _, resolved = client.call("POST", "/api/v1/screens/pairing/resolve", {"code": session["code"]}, expect=200)
        client.call("POST", f"/api/v1/screens/pairing/{resolved['data']['id']}/approve", {"name": "Lobby"}, expect=200)
        poll_headers = {"Authorization": f"Pairing {session['pollSecret']}"}
        _, poll = player.call("GET", f"/api/v1/player/pairing-sessions/{session['id']}", headers=poll_headers, expect=200)
        _, enrolled = player.call("POST", "/api/v1/player/enroll",
                                  {"pairingSessionId": session["id"], "enrollmentToken": poll["data"]["enrollmentToken"]},
                                  expect=201)
        screen_id = enrolled["data"]["screenId"]

        # Legacy state exactly as apps/player-linux writes it.
        legacy = os.path.join(work, "legacy")
        os.makedirs(os.path.join(legacy, "cache", "media"), mode=0o700)
        files = {
            "installation.json": {"playerInstallationId": node_id},
            "credential.json": {"serverUrl": BASE + "/", "installationId": installation_id, "screenId": screen_id,
                                "screenName": enrolled["data"]["screenName"],
                                "deviceCredential": enrolled["data"]["deviceCredential"],
                                "enrolledAt": "2026-09-22T00:00:00Z"},
            "executed-commands.json": {"keys": ["e2e-command-1"]},
            "playback-flags.json": {"playbackDisabled": False},
        }
        for name, value in files.items():
            with open(os.path.join(legacy, name), "w") as handle:
                json.dump(value, handle, indent=2)
            os.chmod(os.path.join(legacy, name), 0o600)
        before = tree(legacy)

        state, runtime = os.path.join(work, "state"), os.path.join(work, "run")
        config = os.path.join(work, "edge.toml")
        with open(config, "w") as handle:
            handle.write(f'[paths]\nstate_dir = "{state}"\nruntime_dir = "{runtime}"\n[log]\nformat = "text"\n')

        run(tilecastd, "--config", config, "import-legacy", "--from", legacy)
        again = subprocess.run([tilecastd, "--config", config, "import-legacy", "--from", legacy],
                               check=True, capture_output=True, text=True)
        assert "already imported" in again.stdout, again.stdout
        assert tree(legacy) == before, "legacy state changed"
        assert oct(os.stat(os.path.join(state, "identity", "device-credential")).st_mode & 0o777) == "0o600"

        daemon_log = open(os.path.join(work, "tilecastd.log"), "w")
        daemon = subprocess.Popen([tilecastd, "--config", config, "run"], stdout=daemon_log, stderr=subprocess.STDOUT)
        processes.append(daemon)

        def node_listed():
            status, nodes = client.call("GET", "/api/v1/edge/nodes")
            items = (nodes or {}).get("data", {}).get("items", []) if status == 200 else []
            return next((n for n in items if n.get("nodeId") == node_id and n.get("lastEdgeContactAt")), None)

        node = wait_for(node_listed, "Edge enrollment and status report")
        print("dashboard sees node:", node["nodeId"], node["rendererState"], node["meshState"], node["certificateExpiresAt"])
        def player_contact():
            code, screen = client.call("GET", f"/api/v1/screens/{screen_id}")
            return code == 200 and screen["data"]["status"] == "online"
        wait_for(player_contact, "normal player WebSocket presence")
        def clock_sampled():
            with sqlite3.connect(os.path.join(state, "state.db")) as db:
                row = db.execute("SELECT server_clock_synchronized_at_ms FROM playback_state WHERE id=1").fetchone()
                return row is not None and row[0] is not None
        wait_for(clock_sampled, "server clock sample from socket ping", timeout=50)
        credential_path = os.path.join(state, "identity", "device-credential")
        assert os.path.exists(credential_path)

        server_process.terminate()
        assert server_process.wait(timeout=20) == 0, "server did not stop cleanly"
        processes.remove(server_process)
        time.sleep(2)
        assert os.path.exists(credential_path), "temporary server outage erased the credential"
        server_process = subprocess.Popen([server_bin], env=env, stdout=server_log, stderr=subprocess.STDOUT)
        processes.append(server_process)
        wait_for(lambda: client.call("GET", "/readyz")[0] == 200, "server restart readiness")
        wait_for(player_contact, "player WebSocket reconnection after server restart", timeout=90)

        client.call("POST", f"/api/v1/screens/{screen_id}/disable", {}, expect=204)
        assert os.path.exists(credential_path), "screen disable erased the credential"
        client.call("POST", f"/api/v1/screens/{screen_id}/enable", {}, expect=204)
        wait_for(player_contact, "player WebSocket reconnection after screen enable", timeout=90)
        socket = os.path.join(runtime, "edge.sock")
        status = subprocess.run([tilecastctl, "--socket", socket, "--json", "status"], check=True,
                                capture_output=True, text=True)
        identity_state = json.loads(status.stdout)["identity"]["state"]
        assert identity_state == "enrolled", status.stdout

        # A live revocation must close the socket and invalidate the credential.
        client.call("POST", f"/api/v1/screens/{screen_id}/revoke", {}, expect=204)
        wait_for(lambda: not os.path.exists(credential_path), "credential removal after revocation")
        assert tree(legacy) == before, "legacy state changed"
        print("PASS: import, HTTPS Edge enrollment, player socket, server restart, disable/enable, live revocation")
        return 0
    except Exception:
        for name in ("server.log", "tilecastd.log"):
            path = os.path.join(work, name)
            if os.path.exists(path):
                print(f"==== {name}", file=sys.stderr)
                with open(path) as handle:
                    print(handle.read()[-6000:], file=sys.stderr)
        raise
    finally:
        if proxy is not None:
            proxy.shutdown()
            proxy.server_close()
        for process in processes:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        subprocess.run(["dropdb", "--if-exists", DATABASE], check=False)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
