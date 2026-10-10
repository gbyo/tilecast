#!/usr/bin/env python3
"""Runs the shipped Edge 0.2.1 update helper over this branch's release files.

Edge 0.2.1 and older update themselves with the helper they already run, and
that helper computes a release's version code with the legacy rule. Whether the
bridge release (docs/release-process.md) really installs on such a screen is a
question about that exact code, so this script does not re-implement it: it
checks out the shipped tag, adds one test module (legacy-oracle/
legacy_bridge_oracle.rs) to its update helper crate, and runs it there. The
module drives the tag's own `Updater`, envelope and manifest verification and
archive staging.

  legacy_oracle.py path    the whole cross-version path on synthetic releases
                           (a throwaway key): this branch's helper installs
                           the candidates, the shipped helper installs the
                           bridge and refuses every unified release, and this
                           branch's helper then continues to the unified Beta
                           and Stable from what the shipped helper left
  legacy_oracle.py assets  the shipped helper against real, signed assets: the
                           published preview and a bridge release build. It is
                           the last check before a bridge release is published

It builds the tag with its own Cargo.lock in a separate target directory, so
the first run compiles the helper's dependencies for the shipped commit.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../.."))
ORACLE = os.path.join(HERE, "legacy-oracle", "legacy_bridge_oracle.rs")
SHIPPED_TAG = "edge-v0.2.1-preview.1"
SHIPPED_VERSION = "0.2.1"
HELPER = "apps/edge/tilecast-edge-update"
MODULE = "legacy_bridge_oracle"
BRIDGE_TEST = "legacy_helper_installs_the_bridge_and_refuses_unified_releases"
ASSETS_TEST = "legacy_helper_against_real_assets"
UNIFIED = "0.26.0-beta.1 0.26.0 0.26.1-beta.1"


class OracleError(Exception):
    pass


def run(command, cwd, env=None, quiet=False):
    merged = dict(os.environ, **(env or {}))
    result = subprocess.run(command, cwd=cwd, env=merged, text=True, capture_output=quiet)
    if result.returncode != 0:
        detail = (result.stdout or "") + (result.stderr or "") if quiet else ""
        raise OracleError(f"{' '.join(command)} failed ({result.returncode})\n{detail}".rstrip())
    return result


def checkout_shipped(destination, repo=ROOT, tag=SHIPPED_TAG):
    """Extracts the shipped tag's tree and adds the oracle test module to its
    update helper crate. Returns the tree's path."""
    exists = subprocess.run(["git", "-C", repo, "rev-parse", "--verify", "-q", f"refs/tags/{tag}^{{commit}}"], capture_output=True)
    if exists.returncode != 0:
        raise OracleError(f"the tag {tag} is not available; fetch it with: git fetch origin tag {tag} --no-tags")
    tree = os.path.join(destination, "shipped")
    os.makedirs(tree)
    archive = subprocess.Popen(["git", "-C", repo, "archive", tag], stdout=subprocess.PIPE)
    extract = subprocess.run(["tar", "-x", "-C", tree], stdin=archive.stdout)
    archive.stdout.close()
    if archive.wait() != 0 or extract.returncode != 0:
        raise OracleError(f"cannot extract {tag}")
    install_oracle(tree)
    return tree


def install_oracle(tree):
    source = os.path.join(tree, HELPER, "src")
    shutil.copyfile(ORACLE, os.path.join(source, MODULE + ".rs"))
    lib = os.path.join(source, "lib.rs")
    with open(lib) as handle:
        text = handle.read()
    if "mod fake;" not in text:
        raise OracleError("the shipped helper has no in-memory test host to run the oracle on")
    with open(lib, "w") as handle:
        handle.write(text.rstrip("\n") + f"\n\n#[cfg(test)]\nmod {MODULE};\n")


def cargo_test(cwd, target_dir, name, env, module=None):
    command = ["cargo", "test", "--locked", "-p", "tilecast-edge-update", "--lib", "--", "--ignored", "--exact", "--nocapture", name]
    return run(command, cwd, dict(env, CARGO_TARGET_DIR=target_dir) if target_dir else env)


def path(args):
    work = tempfile.mkdtemp(prefix="bridge-path-")
    try:
        shared = os.path.join(work, "shared")
        os.makedirs(shared)
        env = {"TILECAST_BRIDGE_PATH_DIR": shared, "TILECAST_BRIDGE_BASE": SHIPPED_VERSION,
               "TILECAST_BRIDGE_VERSION": args.bridge_version, "TILECAST_BRIDGE_UNIFIED": UNIFIED}
        tree = checkout_shipped(work, tag=args.tag)
        print("1/3 this branch builds and signs the candidates and installs the preview")
        cargo_test(ROOT, args.target_dir, "bridge_path_tests::bridge_produce", env)
        print(f"2/3 the shipped {SHIPPED_VERSION} helper installs the bridge and refuses unified releases")
        legacy_target = args.legacy_target_dir or os.path.join(work, "legacy-target")
        cargo_test(tree, legacy_target, f"{MODULE}::{BRIDGE_TEST}", env)
        print("3/3 this branch's helper continues from what the shipped helper left")
        cargo_test(ROOT, args.target_dir, "bridge_path_tests::bridge_continue_after_the_legacy_helper", env)
        print("the path holds: preview -> bridge -> unified Beta -> unified Stable")
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)


def assets(args):
    for name in ("base", "bridge"):
        for part in ("update.json", "update.json.sig", "archive.tar.zst"):
            if not os.path.isfile(os.path.join(args.assets, name, part)):
                raise OracleError(f"{os.path.join(args.assets, name, part)} is missing")
    work = tempfile.mkdtemp(prefix="bridge-assets-")
    try:
        tree = checkout_shipped(work, tag=args.tag)
        env = {"TILECAST_BRIDGE_ORACLE_ASSETS": os.path.abspath(args.assets), "TILECAST_BRIDGE_ORACLE_WORK": os.path.join(work, "run"),
               "TILECAST_BRIDGE_BASE": args.base_version, "TILECAST_BRIDGE_VERSION": args.bridge_version}
        os.makedirs(env["TILECAST_BRIDGE_ORACLE_WORK"])
        target = args.legacy_target_dir or os.path.join(work, "legacy-target")
        cargo_test(tree, target, f"{MODULE}::{ASSETS_TEST}", env)
        print(f"the shipped Edge 0.2.1 helper installed and confirmed {args.bridge_version} on top of {args.base_version}")
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("path", "assets"):
        command = sub.add_parser(name)
        command.add_argument("--tag", default=SHIPPED_TAG, help="the shipped Edge tag whose helper is the oracle")
        command.add_argument("--bridge-version", default="0.2.2")
        command.add_argument("--target-dir", help="cargo target directory for this branch")
        command.add_argument("--legacy-target-dir", help="cargo target directory for the shipped tag (keep it to avoid rebuilding)")
        command.add_argument("--keep", action="store_true", help="keep the temporary working directory")
    sub.choices["assets"].add_argument("--assets", required=True, help="directory with base/ and bridge/ release assets")
    sub.choices["assets"].add_argument("--base-version", default=SHIPPED_VERSION)
    args = parser.parse_args(argv)
    try:
        {"path": path, "assets": assets}[args.command](args)
    except OracleError as error:
        sys.exit(f"legacy_oracle: {error}")


if __name__ == "__main__":
    main()
