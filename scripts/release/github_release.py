#!/usr/bin/env python3
"""GitHub release operations for the coordinated release workflow.

The workflow assembles one draft release, uploads every verified asset to it,
downloads it back and verifies it, and only then publishes. The repository has
immutable releases enabled, so once a release is published its assets and tag
can never change; everything that can go wrong must go wrong while it is still
a draft. `gh release` finds drafts only by listing, so this client talks to the
REST API directly and addresses a release by its id.

Authentication is GH_TOKEN or GITHUB_TOKEN. Nothing here ever prints it.

Usage:
  github_release.py find TAG                        JSON of the release, exit 3 when there is none
  github_release.py create TAG --target SHA --title T --notes-file F [--prerelease]
  github_release.py download TAG --dir D            every asset, draft or published
  github_release.py upload TAG --dir D [--replace]  every file in D; --replace is for drafts
  github_release.py notes TAG --notes-file F        replace the notes of a draft
  github_release.py publish TAG [--latest|--not-latest]
"""
import argparse
import http.client
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.github.com"
UPLOADS = "https://uploads.github.com"
REPOSITORY = os.environ.get("GITHUB_REPOSITORY", "gbyo/tilecast")


class GitHubError(Exception):
    pass


class _RedirectWithoutCredentials(urllib.request.HTTPRedirectHandler):
    """Follows a redirect but never sends the GitHub token to another host.

    An asset download redirects from api.github.com to a storage host. urllib
    would forward the Authorization header there, which leaks the token and
    makes the storage host refuse the request.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        follow = super().redirect_request(req, fp, code, msg, headers, newurl)
        if follow is not None and urllib.parse.urlsplit(newurl).netloc != urllib.parse.urlsplit(req.full_url).netloc:
            for name in [h for h in follow.headers if h.lower() == "authorization"]:
                del follow.headers[name]
            for name in [h for h in follow.unredirected_hdrs if h.lower() == "authorization"]:
                del follow.unredirected_hdrs[name]
        return follow


_OPENER = urllib.request.build_opener(_RedirectWithoutCredentials)


class Client:
    def __init__(self, repository=REPOSITORY, token=None, api=API, uploads=UPLOADS):
        self.repository = repository
        self.token = token or os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
        self.api = api.rstrip("/")
        self.uploads = uploads.rstrip("/")

    def _headers(self, extra=None):
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "tilecast-release",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        headers.update(extra or {})
        return headers

    def _request(self, method, url, body=None, headers=None, expected=(200,)):
        data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
        request = urllib.request.Request(url, data=data, method=method, headers=self._headers(headers))
        if isinstance(body, (dict, list)):
            request.add_header("Content-Type", "application/json")
        try:
            response = _OPENER.open(request, timeout=600)
        except urllib.error.HTTPError as error:
            if error.code in expected:
                return error
            detail = error.read(2000).decode(errors="replace")
            raise GitHubError(f"{method} {url} returned HTTP {error.code}: {detail}") from None
        except urllib.error.URLError as error:
            raise GitHubError(f"{method} {url} failed: {error.reason}") from None
        return response

    def _json(self, method, path, body=None, expected=(200,)):
        with self._request(method, self.api + path, body, expected=expected) as response:
            raw = response.read()
        return json.loads(raw) if raw else None

    # A release is found by listing, because only a listing includes drafts.
    def find(self, tag):
        page = 1
        while True:
            releases = self._json("GET", f"/repos/{self.repository}/releases?per_page=100&page={page}")
            for release in releases:
                if release["tag_name"] == tag:
                    return release
            if len(releases) < 100:
                return None
            page += 1

    def require(self, tag):
        release = self.find(tag)
        if release is None:
            raise GitHubError(f"there is no release {tag}")
        return release

    def create(self, tag, target, title, notes, prerelease):
        if self.find(tag) is not None:
            raise GitHubError(f"release {tag} already exists")
        # Always a draft: the tag does not exist until the draft is published.
        return self._json("POST", f"/repos/{self.repository}/releases", {
            "tag_name": tag, "target_commitish": target, "name": title, "body": notes,
            "draft": True, "prerelease": prerelease, "generate_release_notes": False,
        }, expected=(201,))

    def update(self, release_id, fields):
        return self._json("PATCH", f"/repos/{self.repository}/releases/{release_id}", fields)

    def download(self, release, directory):
        os.makedirs(directory, exist_ok=True)
        names = []
        for asset in release["assets"]:
            path = os.path.join(directory, asset["name"])
            with self._request(
                "GET", f"{self.api}/repos/{self.repository}/releases/assets/{asset['id']}",
                headers={"Accept": "application/octet-stream"},
            ) as response, open(path, "wb") as handle:
                while chunk := response.read(1 << 20):
                    handle.write(chunk)
            if os.path.getsize(path) != asset["size"]:
                raise GitHubError(f"{asset['name']} downloaded with {os.path.getsize(path)} bytes, expected {asset['size']}")
            names.append(asset["name"])
        return sorted(names)

    def delete_asset(self, asset_id):
        self._request("DELETE", f"{self.api}/repos/{self.repository}/releases/assets/{asset_id}", expected=(204,)).close()

    def upload(self, release, directory, replace=False):
        """Uploads every file of `directory`. An existing asset of the same
        name is an error unless `replace` is set, and a published release never
        takes `replace`: its assets are immutable."""
        if replace and not release["draft"]:
            raise GitHubError("a published release is immutable: its assets cannot be replaced")
        existing = {asset["name"]: asset for asset in release["assets"]}
        uploaded = []
        for name in sorted(os.listdir(directory)):
            path = os.path.join(directory, name)
            if not os.path.isfile(path):
                continue
            if name in existing:
                if not replace:
                    raise GitHubError(f"{name} is already attached to the release")
                self.delete_asset(existing[name]["id"])
            self._upload_one(release, name, path)
            uploaded.append(name)
        return uploaded

    def _upload_one(self, release, name, path):
        url = urllib.parse.urlsplit(self.uploads)
        target = f"/repos/{self.repository}/releases/{release['id']}/assets?name={urllib.parse.quote(name)}"
        connection_class = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
        connection = connection_class(url.netloc, timeout=1800)
        try:
            with open(path, "rb") as handle:
                headers = self._headers({"Content-Type": "application/octet-stream", "Content-Length": str(os.path.getsize(path))})
                connection.request("POST", target, body=handle, headers=headers)
                response = connection.getresponse()
                body = response.read(2000).decode(errors="replace")
        finally:
            connection.close()
        if response.status != 201:
            raise GitHubError(f"uploading {name} returned HTTP {response.status}: {body}")

    def publish(self, release, latest):
        if not release["draft"]:
            return release
        return self.update(release["id"], {"draft": False, "make_latest": "true" if latest else "false"})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["find", "create", "download", "upload", "notes", "publish"])
    parser.add_argument("tag")
    parser.add_argument("--target")
    parser.add_argument("--title")
    parser.add_argument("--notes-file")
    parser.add_argument("--prerelease", action="store_true")
    parser.add_argument("--dir")
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--latest", action="store_true")
    parser.add_argument("--not-latest", action="store_true")
    args = parser.parse_args(argv)
    client = Client()
    try:
        if args.command == "find":
            release = client.find(args.tag)
            if release is None:
                return 3
            print(json.dumps({
                "id": release["id"], "tag": release["tag_name"], "draft": release["draft"],
                "prerelease": release["prerelease"], "target": release["target_commitish"],
                "assets": [{"name": a["name"], "size": a["size"]} for a in release["assets"]],
            }, indent=2, sort_keys=True))
        elif args.command == "create":
            if not (args.target and args.title and args.notes_file):
                parser.error("create needs --target, --title and --notes-file")
            with open(args.notes_file) as handle:
                release = client.create(args.tag, args.target, args.title, handle.read(), args.prerelease)
            print(f"created draft release {args.tag} ({release['id']})")
        elif args.command == "download":
            names = client.download(client.require(args.tag), args.dir)
            print(f"downloaded {len(names)} assets to {args.dir}")
        elif args.command == "upload":
            names = client.upload(client.require(args.tag), args.dir, replace=args.replace)
            print(f"uploaded {len(names)} assets: {', '.join(names)}")
        elif args.command == "notes":
            release = client.require(args.tag)
            if not release["draft"]:
                raise GitHubError("a published release's notes are not changed by the release workflow")
            with open(args.notes_file) as handle:
                client.update(release["id"], {"body": handle.read()})
            print(f"updated the notes of draft {args.tag}")
        elif args.command == "publish":
            release = client.require(args.tag)
            client.publish(release, latest=args.latest and not args.not_latest)
            print(f"published {args.tag}")
    except GitHubError as error:
        print(f"github_release: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
