#!/usr/bin/env python3
"""Fail when a string the app compiles is missing from a String Catalog.

Xcode extracts every localizable literal into .stringsdata files during a
build. This compares those keys with the app's catalogs and requires a
translation for every shipped language, mirroring Studio's locale parity
test. Usage: check-localization.py <DerivedData path>
"""
import glob
import json
import os
import sys

LANGUAGES = ["es", "ru"]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOGS = {"Localizable": "Tilecast/Resources/Localizable.xcstrings"}


def extracted_keys(derived_data):
    pattern = os.path.join(
        derived_data, "Build/Intermediates.noindex/Tilecast.build/*/Tilecast.build/**/*.stringsdata"
    )
    keys = {}
    for path in glob.glob(pattern, recursive=True):
        for table, entries in json.load(open(path)).get("tables", {}).items():
            for entry in entries:
                keys.setdefault(table, set()).add(entry["key"])
    return keys


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    keys = extracted_keys(sys.argv[1])
    if not keys:
        sys.exit("No .stringsdata found. Build the Tilecast target with SWIFT_EMIT_LOC_STRINGS first.")
    problems = []
    for table, used in sorted(keys.items()):
        if table not in CATALOGS:
            problems.append(f"{table}: no String Catalog for this table")
            continue
        strings = json.load(open(os.path.join(ROOT, CATALOGS[table])))["strings"]
        for key in sorted(used):
            localizations = strings.get(key, {}).get("localizations", {})
            for language in LANGUAGES:
                value = localizations.get(language, {}).get("stringUnit", {})
                if value.get("state") != "translated" or not value.get("value"):
                    problems.append(f"{table}: {language} missing {key!r}")
        for key in sorted(set(strings) - used):
            problems.append(f"{table}: unused key {key!r}")
    if problems:
        print("\n".join(problems))
        sys.exit(1)
    print(f"Localization complete: {sum(map(len, keys.values()))} keys in {', '.join(['en', *LANGUAGES])}.")


if __name__ == "__main__":
    main()
