"""Makes a staged Tilecast Edge release dependency closed, and checks that it is.

A release holds a private WPE WebKit build (lib/wpe) next to the Tilecast
binaries. WebKit is linked against more shared libraries than a Debian 13
installation is guaranteed to provide, and the builder image hides that: it
carries every -dev package WebKit needed to compile. `libwpe-1.0.so.1` was
the library that a real screen lacked.

The contract has two halves:

* `system-baseline.txt` lists the Debian packages the release expects from the
  operating system. A library owned by one of these packages, or by a package
  they depend on, is not carried: the operating system keeps patching it.
* Every other shared library that a binary in the release loads (directly or
  through a carried library) is copied into the release under `lib/wpe/lib`,
  the directory that WebKit's RUNPATH already searches, together with its
  Debian copyright file. `bundled-libraries.json` records what was carried.

`carry` runs in the release builder, where the libraries are installed, and
fails the build if a needed library is nowhere. `verify-runtime-closure.sh`
then checks the finished tree in a clean Debian image that has only the
baseline installed (Dockerfile.closure); the release workflow fails if any
library in the tree does not resolve there.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

BUNDLE_DIR = "lib/wpe/lib"
RECORD = "share/doc/tilecast-edge/bundled-libraries.json"
LICENSE_DIR = "share/doc/tilecast-edge/licenses"
ELF_MAGIC = b"\x7fELF"


def read_baseline(path):
    """Package names, one per line; `#` starts a comment."""
    names = []
    with open(path) as handle:
        for line in handle:
            line = line.split("#", 1)[0].strip()
            if line:
                names.append(line)
    if not names:
        raise ValueError(f"{path} names no packages")
    return names


def is_elf(path):
    try:
        with open(path, "rb") as handle:
            return handle.read(4) == ELF_MAGIC
    except OSError:
        return False


def elf_files(tree):
    """Every ELF file under the tree, sorted, links not followed."""
    found = []
    for root, dirs, names in os.walk(tree):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(root, name)
            if not os.path.islink(path) and is_elf(path):
                found.append(path)
    return found


def needed_libraries(path):
    """The NEEDED sonames of one ELF file (`readelf -d`)."""
    result = subprocess.run(["readelf", "-d", path], capture_output=True, text=True)
    return re.findall(r"\(NEEDED\)\s+Shared library: \[([^\]]+)\]", result.stdout)


def soname_of(path):
    result = subprocess.run(["readelf", "-d", path], capture_output=True, text=True)
    match = re.search(r"\(SONAME\)\s+Library soname: \[([^\]]+)\]", result.stdout)
    return match.group(1) if match else os.path.basename(path)


# ---- the system's side -------------------------------------------------------

def parse_dependency_field(value):
    """Package names in a Depends/Pre-Depends/Provides value, alternatives included."""
    names = []
    for group in (value or "").split(","):
        for alternative in group.split("|"):
            name = re.split(r"[\s(]", alternative.strip(), maxsplit=1)[0]
            name = name.split(":", 1)[0]
            if name:
                names.append(name)
    return names


def installed_packages():
    """{package: {"depends": [...], "provides": [...], "version": v}} from dpkg."""
    out = subprocess.run(
        ["dpkg-query", "-W", "-f", "${Package}\t${Version}\t${Pre-Depends}\t${Depends}\t${Provides}\n"],
        capture_output=True, text=True, check=True,
    ).stdout
    packages = {}
    for line in out.splitlines():
        fields = line.split("\t")
        if len(fields) != 5:
            continue
        name, version, pre, depends, provides = fields
        packages[name] = {
            "version": version,
            "depends": parse_dependency_field(pre) + parse_dependency_field(depends),
            "provides": parse_dependency_field(provides),
        }
    return packages


def dependency_closure(baseline, packages):
    """Every installed package that the baseline packages need, baseline included.

    A dependency on a virtual package counts for every installed package that
    provides it, and an alternative counts when it is installed.
    """
    missing = [name for name in baseline if name not in packages]
    if missing:
        raise ValueError(f"baseline packages are not installed in this image: {', '.join(missing)}")
    providers = {}
    for name, entry in packages.items():
        for provided in entry["provides"]:
            providers.setdefault(provided, []).append(name)
    closure, pending = set(), list(baseline)
    while pending:
        name = pending.pop()
        if name in closure:
            continue
        if name in packages:
            closure.add(name)
            pending.extend(packages[name]["depends"])
        else:
            pending.extend(providers.get(name, []))
    return closure


def ldconfig_map():
    """{soname: path} of the system's shared libraries (`ldconfig -p`)."""
    out = subprocess.run(["/sbin/ldconfig", "-p"], capture_output=True, text=True, check=True).stdout
    libraries = {}
    for line in out.splitlines():
        match = re.match(r"\s*(\S+) \(.*\) => (/\S+)", line)
        if match:
            libraries.setdefault(match.group(1), match.group(2))
    return libraries


def owner_package(path):
    """The Debian package that owns the file, or None."""
    real = os.path.realpath(path)
    for candidate in (real, path):
        result = subprocess.run(["dpkg-query", "-S", candidate], capture_output=True, text=True)
        if result.returncode == 0:
            return result.stdout.split(":", 1)[0].strip()
    return None


# ---- carrying ----------------------------------------------------------------

def plan(tree, closure, libraries, owner, needed=needed_libraries, soname=soname_of, bundled_sonames=None):
    """Which libraries to carry. Pure over its inputs, so it is unit-tested.

    `libraries` maps soname to path, `owner(path)` names a package, and
    `closure` is the set of packages the operating system provides. Raises
    when a needed library is nowhere: that release cannot run.
    """
    carried = {}
    present = set(bundled_sonames or ())
    queue = list(elf_files(tree))
    unresolved = []
    while queue:
        path = queue.pop(0)
        for name in needed(path):
            if name in present or name in carried:
                continue
            source = libraries.get(name)
            if source is None:
                unresolved.append((os.path.relpath(path, tree) if path.startswith(tree) else path, name))
                continue
            package = owner(source)
            if package is not None and package in closure:
                continue
            carried[name] = {"source": os.path.realpath(source), "package": package}
            queue.append(os.path.realpath(source))
    if unresolved:
        lines = "\n".join(f"  {where} needs {name}" for where, name in sorted(set(unresolved)))
        raise ValueError(f"libraries that nothing in this image provides:\n{lines}")
    return carried


def bundled_sonames(tree):
    directory = os.path.join(tree, BUNDLE_DIR)
    if not os.path.isdir(directory):
        return set()
    return set(os.listdir(directory))


def carry(tree, baseline_path):
    """Copies the missing libraries into the staged tree and records them."""
    baseline = read_baseline(baseline_path)
    packages = installed_packages()
    closure = dependency_closure(baseline, packages)
    chosen = plan(tree, closure, ldconfig_map(), owner_package, bundled_sonames=bundled_sonames(tree))
    records = []
    for name, entry in sorted(chosen.items()):
        target = os.path.join(tree, BUNDLE_DIR, name)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(entry["source"], target)
        os.chmod(target, 0o644)
        package = entry["package"]
        version = packages.get(package, {}).get("version", "") if package else ""
        digest = subprocess.run(["sha256sum", target], capture_output=True, text=True, check=True).stdout.split()[0]
        records.append({"soname": name, "package": package, "version": version, "sha256": digest})
        if package:
            copyright_file = f"/usr/share/doc/{package}/copyright"
            if os.path.isfile(copyright_file):
                destination = os.path.join(tree, LICENSE_DIR, f"{package}.copyright")
                os.makedirs(os.path.dirname(destination), exist_ok=True)
                shutil.copyfile(copyright_file, destination)
                os.chmod(destination, 0o644)
    record_path = os.path.join(tree, RECORD)
    os.makedirs(os.path.dirname(record_path), exist_ok=True)
    with open(record_path, "w") as handle:
        json.dump({"libraries": records}, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tree", required=True, help="the staged release tree")
    parser.add_argument("--baseline", required=True, help="system-baseline.txt")
    args = parser.parse_args()
    records = carry(args.tree, args.baseline)
    names = ", ".join(r["soname"] for r in records) or "nothing"
    print(f"runtime closure: carried {len(records)} libraries: {names}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
