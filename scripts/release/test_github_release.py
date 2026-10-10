import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import github_release as gr


class FakeGitHub:
    """A small GitHub: releases, assets, and the immutability rule for
    published releases."""

    def __init__(self):
        self.releases = []
        self.next_id = 100
        self.requests = []
        self.reject_uploads = False
        self.redirect_to = None
        self.storage_data = b""
        self.storage_authorization = "unset"

    def new_release(self, tag, draft=True, prerelease=False, assets=()):
        release = {"id": self.next_id, "tag_name": tag, "draft": draft, "prerelease": prerelease,
                   "target_commitish": "abc", "name": tag, "body": "", "assets": []}
        self.next_id += 1
        for name, data in assets:
            release["assets"].append({"id": self.next_id, "name": name, "size": len(data), "data": data})
            self.next_id += 1
        self.releases.append(release)
        return release


def handler_for(fake):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status, body=b"", content_type="application/json"):
            if not isinstance(body, bytes):
                body = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _public(self, release):
            return {key: value for key, value in release.items() if key != "assets"} | {
                "assets": [{"id": a["id"], "name": a["name"], "size": a["size"]} for a in release["assets"]]
            }

        def _release(self, release_id):
            return next((r for r in fake.releases if r["id"] == release_id), None)

        def do_GET(self):
            fake.requests.append(("GET", self.path, self.headers.get("Authorization")))
            parts = urlsplit(self.path)
            segments = parts.path.strip("/").split("/")
            if segments[0] == "storage":
                # The storage host the asset API redirects to.
                fake.storage_authorization = self.headers.get("Authorization")
                return self._send(200, fake.storage_data, "application/octet-stream")
            if segments[-1] == "releases":
                page = int(parse_qs(parts.query).get("page", ["1"])[0])
                chunk = fake.releases[(page - 1) * 100: page * 100]
                return self._send(200, [self._public(r) for r in chunk])
            if "assets" in segments:
                asset_id = int(segments[-1])
                for release in fake.releases:
                    for asset in release["assets"]:
                        if asset["id"] == asset_id:
                            if fake.redirect_to:
                                fake.storage_data = asset["data"]
                                self.send_response(302)
                                self.send_header("Location", fake.redirect_to + "/storage/blob")
                                self.send_header("Content-Length", "0")
                                self.end_headers()
                                return
                            return self._send(200, asset["data"], "application/octet-stream")
            return self._send(404, {"message": "Not Found"})

        def do_POST(self):
            fake.requests.append(("POST", self.path, self.headers.get("Authorization")))
            parts = urlsplit(self.path)
            segments = parts.path.strip("/").split("/")
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            if segments[-1] == "releases":
                payload = json.loads(body)
                release = fake.new_release(payload["tag_name"], draft=payload["draft"], prerelease=payload["prerelease"])
                release.update(target_commitish=payload["target_commitish"], name=payload["name"], body=payload["body"])
                return self._send(201, self._public(release))
            if segments[-1] == "assets":
                release = self._release(int(segments[-2]))
                name = parse_qs(parts.query)["name"][0]
                if fake.reject_uploads or release is None or not release["draft"]:
                    return self._send(422, {"message": "Validation Failed"})
                if any(a["name"] == name for a in release["assets"]):
                    return self._send(422, {"message": "already_exists"})
                release["assets"].append({"id": fake.next_id, "name": name, "size": len(body), "data": body})
                fake.next_id += 1
                return self._send(201, {"name": name})
            return self._send(404, {"message": "Not Found"})

        def do_PATCH(self):
            fake.requests.append(("PATCH", self.path, self.headers.get("Authorization")))
            release = self._release(int(self.path.strip("/").split("/")[-1]))
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            if release is None or (not release["draft"] and payload.get("body") is not None):
                return self._send(422, {"message": "Validation Failed"})
            release.update({k: v for k, v in payload.items() if k in ("draft", "body")})
            release["latest"] = payload.get("make_latest")
            return self._send(200, self._public(release))

        def do_DELETE(self):
            fake.requests.append(("DELETE", self.path, self.headers.get("Authorization")))
            asset_id = int(self.path.strip("/").split("/")[-1])
            for release in fake.releases:
                release["assets"] = [a for a in release["assets"] if a["id"] != asset_id]
            return self._send(204)

    return Handler


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeGitHub()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(self.fake))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.client = gr.Client("gbyo/tilecast", token="secret-token", api=base, uploads=base)
        self.dir = tempfile.mkdtemp()

    def files(self, **named):
        for name, data in named.items():
            with open(os.path.join(self.dir, name.replace("_", ".")), "wb") as handle:
                handle.write(data)

    def test_find_sees_drafts_and_pages_through_a_long_history(self):
        for index in range(130):
            self.fake.new_release(f"v0.1.{index}", draft=False)
        draft = self.fake.new_release("v9.9.9", draft=True)
        self.assertEqual(self.client.find("v9.9.9")["id"], draft["id"])
        self.assertEqual(self.client.find("v0.1.3")["draft"], False)
        self.assertIsNone(self.client.find("v0.0.0"))

    def test_create_makes_a_draft_and_refuses_an_existing_tag(self):
        release = self.client.create("v0.26.0-beta.1", "deadbeef", "Tilecast 0.26.0-beta.1", "notes", True)
        stored = self.fake.releases[0]
        self.assertTrue(stored["draft"] and stored["prerelease"])
        self.assertEqual((stored["target_commitish"], stored["body"]), ("deadbeef", "notes"))
        self.assertEqual(release["tag_name"], "v0.26.0-beta.1")
        with self.assertRaisesRegex(gr.GitHubError, "already exists"):
            self.client.create("v0.26.0-beta.1", "deadbeef", "x", "n", True)

    def test_upload_then_download_round_trips_every_byte(self):
        self.client.create("v1", "sha", "t", "n", False)
        self.files(a_bin=b"\x00\x01" * 1000, b_json=b"{}")
        release = self.client.require("v1")
        self.assertEqual(self.client.upload(release, self.dir), ["a.bin", "b.json"])
        out = tempfile.mkdtemp()
        self.assertEqual(self.client.download(self.client.require("v1"), out), ["a.bin", "b.json"])
        with open(os.path.join(out, "a.bin"), "rb") as handle:
            self.assertEqual(handle.read(), b"\x00\x01" * 1000)

    def test_an_existing_asset_is_never_replaced_unless_asked(self):
        release = self.fake.new_release("v1", assets=[("a.bin", b"old")])
        self.files(a_bin=b"new")
        with self.assertRaisesRegex(gr.GitHubError, "already attached"):
            self.client.upload(self.client.require("v1"), self.dir)
        self.assertEqual(release["assets"][0]["data"], b"old")
        self.client.upload(self.client.require("v1"), self.dir, replace=True)
        self.assertEqual(self.fake.releases[0]["assets"][0]["data"], b"new")

    def test_a_published_release_is_immutable(self):
        self.fake.new_release("v1", draft=False, assets=[("a.bin", b"x")])
        self.files(b_bin=b"y")
        with self.assertRaisesRegex(gr.GitHubError, "immutable"):
            self.client.upload(self.client.require("v1"), self.dir, replace=True)

    def test_a_failed_upload_is_reported(self):
        self.fake.new_release("v1")
        self.fake.reject_uploads = True
        self.files(a_bin=b"x")
        with self.assertRaisesRegex(gr.GitHubError, "HTTP 422"):
            self.client.upload(self.client.require("v1"), self.dir)

    def test_prune_removes_only_draft_assets_the_assembly_does_not_hold(self):
        self.fake.new_release("v1", assets=[("keep.bin", b"1"), ("stray.bin", b"2"), ("old.json", b"3")])
        self.files(keep_bin=b"1")
        removed = self.client.prune(self.client.require("v1"), self.dir)
        self.assertEqual(removed, ["old.json", "stray.bin"])
        self.assertEqual([a["name"] for a in self.fake.releases[0]["assets"]], ["keep.bin"])

    def test_a_published_release_is_never_pruned(self):
        self.fake.new_release("v1", draft=False, assets=[("stray.bin", b"2")])
        with self.assertRaisesRegex(gr.GitHubError, "immutable"):
            self.client.prune(self.client.require("v1"), self.dir)
        self.assertEqual(len(self.fake.releases[0]["assets"]), 1)

    def test_publish_flips_a_draft_and_is_idempotent(self):
        self.fake.new_release("v1")
        release = self.client.require("v1")
        self.client.publish(release, latest=True)
        self.assertFalse(self.fake.releases[0]["draft"])
        self.assertEqual(self.fake.releases[0]["latest"], "true")
        before = len(self.fake.requests)
        self.client.publish(self.client.require("v1"), latest=True)
        self.assertEqual([r for r in self.fake.requests[before:] if r[0] == "PATCH"], [])

    def test_a_beta_is_published_without_becoming_latest(self):
        self.fake.new_release("v1-beta", prerelease=True)
        self.client.publish(self.client.require("v1-beta"), latest=False)
        self.assertEqual(self.fake.releases[0]["latest"], "false")

    def test_the_token_is_sent_as_a_bearer_credential(self):
        self.client.find("v1")
        self.assertTrue(all(auth == "Bearer secret-token" for _, _, auth in self.fake.requests))

    def test_a_download_redirect_to_another_host_never_carries_the_token(self):
        self.fake.new_release("v1", draft=False, assets=[("a.bin", b"payload")])
        # The same server answers on two host names, so the redirect leaves the
        # host the token was sent to.
        port = self.server.server_address[1]
        self.fake.redirect_to = f"http://localhost:{port}"
        out = tempfile.mkdtemp()
        self.assertEqual(self.client.download(self.client.require("v1"), out), ["a.bin"])
        self.assertEqual(open(os.path.join(out, "a.bin"), "rb").read(), b"payload")
        self.assertIsNone(self.fake.storage_authorization, "the token was sent to the storage host")

    def test_a_short_download_is_an_error(self):
        release = self.fake.new_release("v1", draft=False, assets=[("a.bin", b"abcdef")])
        release["assets"][0]["size"] = 99
        with self.assertRaisesRegex(gr.GitHubError, "expected 99"):
            self.client.download(self.client.require("v1"), tempfile.mkdtemp())

    def test_a_missing_release_is_an_error(self):
        with self.assertRaisesRegex(gr.GitHubError, "there is no release"):
            self.client.require("v404")


if __name__ == "__main__":
    unittest.main()
