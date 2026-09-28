#!/usr/bin/env python3
"""Writes the signed update envelope of a Tilecast Edge release (M10).

The envelope binds the downloadable archive to the release manifest inside
it: its name, size and SHA-256, the SHA-256 of tilecast-edge-release.json and
of the SBOM, and the state database schema the release migrates to. The
release build signs it with the Tilecast update key exactly as it signs the
manifest (openssl pkeyutl -sign -rawin, base64). The format is
apps/edge/crates/edge-release/src/envelope.rs; the server, tilecastd and
tilecast-edge-update all verify it.

Usage:
  envelope.py --tree DIR --archive FILE --arch ARCH --state-schema N \
              [--channel stable|beta] [--notes TEXT] --out FILE
"""
import argparse
import hashlib
import json
import os
import re
import sys


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tree", required=True)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--arch", required=True, choices=["x86_64", "aarch64"])
    parser.add_argument("--state-schema", required=True, type=int)
    parser.add_argument("--channel", default="stable", choices=["stable", "beta"])
    parser.add_argument("--notes", default="")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    manifest_path = os.path.join(args.tree, "tilecast-edge-release.json")
    with open(manifest_path, "rb") as handle:
        manifest = json.load(handle)
    version = manifest["versionName"]
    if manifest["arch"] != args.arch:
        sys.exit(f"envelope: the tree is for {manifest['arch']}, not {args.arch}")
    if not re.fullmatch(r"[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(-[0-9A-Za-z.]+)?", version):
        sys.exit(f"envelope: invalid version {version}")
    archive_name = f"tilecast-edge-{version}-{args.arch}.tar.zst"
    if os.path.basename(args.archive) != archive_name:
        sys.exit(f"envelope: the archive must be named {archive_name}")
    if args.state_schema < 1 or len(args.notes) > 4000:
        sys.exit("envelope: invalid state schema or release notes")
    envelope = {
        "schemaVersion": 1,
        "product": "tilecast-edge",
        "playerFamily": "edge",
        "platform": "linux",
        "arch": args.arch,
        "versionName": version,
        "versionCode": manifest["versionCode"],
        "channel": args.channel,
        "releaseNotes": args.notes,
        "artifactAssetName": archive_name,
        "artifactSizeBytes": os.path.getsize(args.archive),
        "artifactSha256": sha256(args.archive),
        "releaseManifestSha256": sha256(manifest_path),
        "sbomSha256": sha256(os.path.join(args.tree, "share/doc/tilecast-edge/sbom.cdx.json")),
        "stateSchemaVersion": args.state_schema,
    }
    with open(args.out, "w") as handle:
        json.dump(envelope, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"envelope: {archive_name} ({envelope['artifactSizeBytes']} bytes) in {args.out}")


if __name__ == "__main__":
    sys.exit(main())
