#!/usr/bin/env python3
"""Build-input fingerprints: the proof that a component may be carried forward.

A coordinated release may carry a component forward from an earlier release
instead of building it again (release_reuse.py). That is allowed only when the
component's build inputs are byte-identical to the ones its earlier build used.
This module computes that fingerprint from a git commit, and nothing else.

A component's inputs are the whole repository tree at the commit, minus the
paths that its profile in contract.json says the component is not built from.
The exclusions are the short list, on purpose: a path nobody listed counts, so
a new directory, a lockfile, a toolchain pin, or a shared package that the
component might use forces a rebuild. Reuse is only ever the cheaper path when
it can be proven, never a guess about what a change touches.

The fingerprint records one digest per group of files (one per application or
package directory, and one for the repository root), so a refused reuse can
name the groups that changed. It also covers the component's own definition in
the release contract: its assets, its architecture, and the channels that
require it.

Usage:
  release_inputs.py fingerprint --commit SHA [--repo DIR]     one JSON document, every component
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = 1
ROOT_GROUP = "(root)"
# Directories whose children are separate groups: apps/server and apps/edge are
# different things to a build, packages/player-runtime and packages/plugin-sdk too.
NESTED = ("apps", "packages")


class InputsError(Exception):
    pass


def load_contract():
    with open(os.path.join(HERE, "contract.json")) as handle:
        return json.load(handle)


def _pattern(glob):
    """A path glob as a regular expression. `**` crosses directories, `*` and
    `?` do not, and a pattern is anchored at the repository root."""
    out, index = [], 0
    while index < len(glob):
        if glob.startswith("**/", index):
            out.append("(?:.*/)?")
            index += 3
        elif glob.startswith("**", index):
            out.append(".*")
            index += 2
        elif glob[index] == "*":
            out.append("[^/]*")
            index += 1
        elif glob[index] == "?":
            out.append("[^/]")
            index += 1
        else:
            out.append(re.escape(glob[index]))
            index += 1
    return re.compile("".join(out))


def rules_for(contract, component):
    """The (exclude, keep) patterns of one component: the release-wide rules
    followed by its own profile. A `keep` pattern re-includes what an
    `exclude` pattern removed."""
    reuse = contract["reuse"]
    profile = reuse["profiles"][component["inputs"]]
    exclude = [_pattern(p) for p in reuse["exclude"] + profile["exclude"]]
    keep = [_pattern(p) for p in reuse["keep"] + profile["keep"]]
    return exclude, keep


def counts(path, rules):
    """Whether a repository path is an input under the given rules."""
    exclude, keep = rules
    if any(p.fullmatch(path) for p in keep):
        return True
    return not any(p.fullmatch(path) for p in exclude)


def group_of(path):
    parts = path.split("/")
    if len(parts) == 1:
        return ROOT_GROUP
    if parts[0] in NESTED and len(parts) > 2:
        return "/".join(parts[:2])
    return parts[0]


def tree(repo, commit):
    """Every tracked file at the commit and its git object id."""
    try:
        raw = subprocess.run(
            ["git", "-C", repo, "ls-tree", "-r", "-z", "--full-tree", commit],
            capture_output=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError) as error:
        detail = getattr(error, "stderr", b"") or b""
        raise InputsError(f"cannot read commit {commit}: {detail.decode(errors='replace').strip() or error}") from None
    files = {}
    for entry in raw.split(b"\0"):
        if not entry:
            continue
        meta, _, path = entry.partition(b"\t")
        mode, kind, oid = meta.decode().split(" ")
        if kind == "blob":
            files[path.decode()] = f"{mode}:{oid}"
        # A submodule (kind "commit") is part of the inputs by its pinned commit.
        elif kind == "commit":
            files[path.decode()] = f"{mode}:{oid}"
    return files


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def definition_digest(component):
    return hashlib.sha256(canonical(component).encode()).hexdigest()


def fingerprint(contract, component, files):
    """The fingerprint of one component, from the file listing of a commit."""
    rules = rules_for(contract, component)
    groups = {}
    for path in sorted(files):
        if counts(path, rules):
            groups.setdefault(group_of(path), []).append(f"{path}\0{files[path]}")
    digests = {group: hashlib.sha256("\n".join(entries).encode()).hexdigest() for group, entries in sorted(groups.items())}
    body = {"schema": SCHEMA, "component": definition_digest(component), "groups": digests}
    return {
        "schema": SCHEMA,
        "digest": "sha256:" + hashlib.sha256(canonical(body).encode()).hexdigest(),
        "component": body["component"],
        "groups": digests,
    }


def fingerprints(contract, repo, commit):
    files = tree(repo, commit)
    return {c["id"]: fingerprint(contract, c, files) for c in contract["components"]}


def differences(old, new):
    """What differs between two fingerprints, as readable names. Empty when
    they are identical."""
    if not isinstance(old, dict) or old.get("schema") != SCHEMA or not old.get("digest"):
        return ["the earlier release records no build inputs"]
    if old["digest"] == new["digest"]:
        return []
    names = []
    if old.get("component") != new["component"]:
        names.append("the component's release contract entry")
    old_groups, new_groups = old.get("groups", {}), new["groups"]
    for group in sorted(set(old_groups) | set(new_groups)):
        if old_groups.get(group) != new_groups.get(group):
            names.append(group)
    return names or ["the build inputs"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["fingerprint"])
    parser.add_argument("--commit", required=True)
    parser.add_argument("--repo", default=".")
    args = parser.parse_args(argv)
    try:
        result = fingerprints(load_contract(), args.repo, args.commit)
    except InputsError as error:
        sys.exit(f"release_inputs: {error}")
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
