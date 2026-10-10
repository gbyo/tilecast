#!/usr/bin/env python3
"""Stamps one coordinated release version into the product version sources.

Each platform keeps its own version source: apps/edge/release/VERSION,
apps/player-windows/release/VERSION, and the versionName and versionCode lines
in apps/player-android/app/build.gradle.kts. Their checked-in values are the
development versions. A release build runs this script first, in its own
checkout, so every artifact it builds reports the release version and carries
the update version code release_version.py derives. Nothing is committed: the
release commit stays the commit that was tested, and the tag names the version.

The Edge bridge release (docs/release-process.md) is the one build that is not
a coordinated release. It stamps only Edge, with a legacy-compatible version
such as 0.2.2 that a deployed Edge 0.2.1 screen accepts:

Usage:
  stamp_version.py --version 0.26.0-beta.1 [--root DIR]            stamp the files
  stamp_version.py --version 0.26.0-beta.1 [--root DIR] --check    fail unless stamped
  stamp_version.py --version 0.2.2 --edge-only [--root DIR]        stamp the Edge bridge
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import release_version  # noqa: E402

VERSION_FILES = ("apps/edge/release/VERSION", "apps/player-windows/release/VERSION")
GRADLE_FILE = "apps/player-android/app/build.gradle.kts"
CODE_LINE = re.compile(r"^(\s*versionCode = )[0-9]+\s*$", re.M)
NAME_LINE = re.compile(r'^(\s*versionName = )"[^"]*"\s*$', re.M)


def stamped(root, version, code, edge_only=False):
    """The new content of every version source, keyed by relative path."""
    changes = {}
    if edge_only:
        return {"apps/edge/release/VERSION": version + "\n"}
    for relative in VERSION_FILES:
        changes[relative] = version + "\n"
    with open(os.path.join(root, GRADLE_FILE)) as handle:
        gradle = handle.read()
    for pattern, replacement in ((CODE_LINE, rf"\g<1>{code}"), (NAME_LINE, rf'\g<1>"{version}"')):
        if len(pattern.findall(gradle)) != 1:
            sys.exit(f"stamp: expected exactly one {pattern.pattern.strip()} line in {GRADLE_FILE}")
        gradle = pattern.sub(replacement, gradle)
    changes[GRADLE_FILE] = gradle
    return changes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--root", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--edge-only", action="store_true", help="stamp Tilecast Edge only, with a version below 0.26.0 (the bridge release)")
    args = parser.parse_args()
    if args.edge_only:
        parsed = release_version.parse_version(args.version)
        if parsed is None or parsed.unified or args.version != parsed.name:
            sys.exit(f"stamp: {args.version!r} is not a bridge version: use a valid version below 0.26.0")
    else:
        try:
            parsed = release_version.parse_tag("v" + args.version)
        except ValueError as error:
            sys.exit(f"stamp: {error}")
    root = os.path.abspath(args.root)
    changes = stamped(root, parsed.name, parsed.code, args.edge_only)
    drift = []
    for relative, content in changes.items():
        path = os.path.join(root, relative)
        with open(path) as handle:
            current = handle.read()
        if current != content:
            drift.append(relative)
            if not args.check:
                with open(path, "w") as handle:
                    handle.write(content)
    if args.check and drift:
        sys.exit("stamp: not stamped with " + parsed.name + ": " + ", ".join(drift))
    for relative in changes:
        print(f"stamp: {relative} -> {parsed.name} ({parsed.code})" + (" (changed)" if relative in drift else ""))


if __name__ == "__main__":
    main()
