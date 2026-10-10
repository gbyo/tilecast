#!/usr/bin/env python3
"""Tilecast release versions: one parse and one ordering for every platform.

A coordinated release is tagged vX.Y.Z (Stable) or vX.Y.Z-beta.N (Beta). The
update version code derived from a version name is the one number the server,
Tilecast Edge, the Windows Player, the Android build, and the release scripts
all compare. The rule, in full:

* A name below the unified cutover (a core code under 26000, that is, before
  0.26.0) keeps its legacy code, MAJOR*1000000 + MINOR*1000 + PATCH, and the
  prerelease suffix does not count. Every version that shipped before the
  unified release keeps the code it shipped with.
* From the cutover on a name is X.Y.Z or X.Y.Z-beta.N with N from 1 to 98, and
  its code is the core code times 100 plus a slot: N for a Beta, 99 for Stable.
  Beta 1, Beta 2, Stable, then the next version strictly increase, so a Beta
  can update to the next Beta or to Stable.
* No code exceeds 2100000000, the Android versionCode ceiling.

packages/player-contracts/fixtures/release-versions.json is the corpus that
every implementation of this rule runs: this file, the Go server
(apps/server/internal/updates/versioning.go), Tilecast Edge
(edge-release::manifest), and the Windows Player (tilecast_windows::update).

Usage:
  release_version.py tag vX.Y.Z[-beta.N]   print version, channel, code, ... as KEY=VALUE
  release_version.py code NAME             print the version code, or fail
  release_version.py compare A B           print -1, 0, or 1 by update ordering
"""
import re
import sys

CUTOVER_CORE_CODE = 26_000
MAXIMUM_CODE = 2_100_000_000
BETA_SLOT_MAXIMUM = 98
STABLE_SLOT = 99

VERSION_NAME = re.compile(r"[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(?:-[0-9A-Za-z.]+)?")
BETA_SUFFIX = re.compile(r"beta\.([1-9][0-9]?)")
TAG = re.compile(r"v(?P<version>[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[1-9][0-9]?)?)")


class Version:
    """A parsed version name: its code, implied channel, and core triple."""

    def __init__(self, name, code, channel, core):
        self.name = name
        self.code = code
        self.channel = channel  # "stable", "beta", or None below the cutover
        self.core = core  # (major, minor, patch)

    @property
    def unified(self):
        return self.channel is not None


def parse_version(name):
    """Returns a Version, or None when the name is not a valid release version."""
    if not isinstance(name, str) or len(name) > 64 or not VERSION_NAME.fullmatch(name):
        return None
    core, _, suffix = name.partition("-")
    major, minor, patch = (int(part) for part in core.split("."))
    if major >= 1_000_000 or minor >= 1_000 or patch >= 1_000:
        return None
    core_code = major * 1_000_000 + minor * 1_000 + patch
    if core_code < CUTOVER_CORE_CODE:
        return Version(name, core_code, None, (major, minor, patch))
    if not suffix:
        slot, channel = STABLE_SLOT, "stable"
    else:
        match = BETA_SUFFIX.fullmatch(suffix)
        if not match or not 1 <= int(match.group(1)) <= BETA_SLOT_MAXIMUM:
            return None
        slot, channel = int(match.group(1)), "beta"
    code = core_code * 100 + slot
    if code > MAXIMUM_CODE:
        return None
    return Version(name, code, channel, (major, minor, patch))


def version_code(name):
    parsed = parse_version(name)
    return None if parsed is None else parsed.code


def version_channel(name):
    parsed = parse_version(name)
    return None if parsed is None else parsed.channel


def parse_tag(tag):
    """Validates a coordinated release tag and returns its Version.

    Raises ValueError for anything else: a tag below the cutover, a prerelease
    other than beta.N, or a product-specific tag such as player-v0.25.0.
    """
    match = TAG.fullmatch(tag or "")
    if not match:
        raise ValueError("release tag must use vX.Y.Z or vX.Y.Z-beta.N")
    parsed = parse_version(match.group("version"))
    if parsed is None or not parsed.unified:
        raise ValueError(
            f"{tag} is not a coordinated release version: it must be 0.26.0 or later, "
            "with a beta number from 1 to 98 for a Beta, and below 21.0.0"
        )
    return parsed


def compare(a, b):
    """Orders two release versions by update ordering: -1, 0, or 1."""
    left, right = parse_version(a), parse_version(b)
    if left is None or right is None:
        raise ValueError("both arguments must be release versions")
    return (left.code > right.code) - (left.code < right.code)


def _main(argv):
    if len(argv) == 2 and argv[0] == "tag":
        try:
            parsed = parse_tag(argv[1])
        except ValueError as error:
            sys.exit(f"release_version: {error}")
        print(f"tag=v{parsed.name}")
        print(f"version={parsed.name}")
        print(f"channel={parsed.channel}")
        print(f"prerelease={'true' if parsed.channel == 'beta' else 'false'}")
        print(f"code={parsed.code}")
    elif len(argv) == 2 and argv[0] == "code":
        code = version_code(argv[1])
        if code is None:
            sys.exit(f"release_version: {argv[1]!r} is not a release version")
        print(code)
    elif len(argv) == 3 and argv[0] == "compare":
        try:
            print(compare(argv[1], argv[2]))
        except ValueError as error:
            sys.exit(f"release_version: {error}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    _main(sys.argv[1:])
