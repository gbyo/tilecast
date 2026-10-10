#!/usr/bin/env python3
"""Decides what a coordinated release may do: whether it may be published,
whether it is a fresh or a resumed run, which notes baseline to use, and which
Server image aliases it may move.

The decisions read the repository's GitHub releases, listed with
`gh release list --json tagName,isDraft,isPrerelease`. Nothing else is
consulted, so the same decision is reproducible from the same list.

Ordering rules (the update ordering of release_version.py):
* A Stable release must be newer than every published Stable release.
* A Beta release must be newer than every published release, Beta or Stable.
  Once Stable 0.26.0 is out, 0.26.0-beta.3 can no longer be published.
* A release whose tag is already published is a resumed run. It is never
  checked for ordering again, and it moves only the aliases it still owns.

Alias rules, which are what makes an alias unable to move backwards:
* `stable` and `latest` name the newest published Stable release.
* `beta` names the newest published release of either kind, so Beta users
  are carried to Stable instead of being left behind it.
* Development images never touch any of them (server-image.yml).

Usage:
  release_plan.py --tag vX.Y.Z[-beta.N] --releases releases.json
prints one JSON document; exits 1 with a reason on stderr when the release
may not be published.
"""
import argparse
import json
import sys

import release_version as rv


class PlanError(Exception):
    pass


def published(releases):
    """Published coordinated releases as parsed versions, newest first."""
    found = {}
    for release in releases:
        if release.get("isDraft"):
            continue
        try:
            version = rv.parse_tag(release.get("tagName", ""))
        except ValueError:
            continue
        found[version.name] = version
    return sorted(found.values(), key=lambda version: version.code, reverse=True)


def drafted(releases, tag):
    return any(release.get("isDraft") and release.get("tagName") == tag for release in releases)


def newest(versions, channel=None):
    for version in versions:  # newest first
        if channel is None or version.channel == channel:
            return version
    return None


def aliases_for(version, published_versions):
    """The aliases a published release is entitled to, given every published
    release including itself. An alias moves only to the newest release it
    tracks, so promoting an older release never moves it backwards."""
    everything = {v.name: v for v in published_versions}
    everything[version.name] = version
    ordered = sorted(everything.values(), key=lambda v: v.code, reverse=True)
    newest_stable = newest(ordered, "stable")
    newest_any = newest(ordered)
    stable = version.channel == "stable" and newest_stable.name == version.name
    return {
        "stable": stable,
        "latest": stable,
        "beta": newest_any.name == version.name,
    }


def plan(tag, releases):
    version = rv.parse_tag(tag)
    versions = published(releases)
    names = {v.name for v in versions}
    if version.name in names:
        state = "published"
    elif drafted(releases, tag):
        state = "draft"
    else:
        state = "new"
    if state != "published":
        newest_stable = newest(versions, "stable")
        if version.channel == "stable" and newest_stable and version.code <= newest_stable.code:
            raise PlanError(
                f"Stable {version.name} must be newer than the newest published Stable release, "
                f"{newest_stable.name}. Publishing it would move the stable alias backwards."
            )
        newest_any = newest(versions)
        if version.channel == "beta" and newest_any and version.code <= newest_any.code:
            raise PlanError(
                f"Beta {version.name} must be newer than the newest published release, "
                f"{newest_any.name}. Publishing it would move the beta alias backwards."
            )
    # Release notes compare against the release this one follows: a Stable
    # against the previous Stable, a Beta against whatever came just before.
    earlier = [v for v in versions if v.code < version.code]
    previous = newest(earlier, "stable") if version.channel == "stable" else newest(earlier)
    return {
        "tag": f"v{version.name}",
        "version": version.name,
        "channel": version.channel,
        "prerelease": version.channel == "beta",
        "versionCode": version.code,
        "state": state,
        "previousTag": f"v{previous.name}" if previous else "",
        "aliases": aliases_for(version, versions),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--releases", required=True, help="JSON from gh release list --json tagName,isDraft,isPrerelease")
    args = parser.parse_args()
    with open(args.releases) as handle:
        releases = json.load(handle)
    try:
        result = plan(args.tag, releases)
    except (ValueError, PlanError) as error:
        sys.exit(f"release_plan: {error}")
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
