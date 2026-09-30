#!/usr/bin/env python3
"""Print an xcodebuild destination for an available iPhone or iPad simulator.

Runner images change their simulator set over time, so CI picks one from
what is installed instead of naming a device: the newest iOS runtime, and
the first device of the requested family on it. Pass --ipad for an iPad.
"""
import json
import subprocess
import sys

family = "iPad" if "--ipad" in sys.argv[1:] else "iPhone"
devices = json.loads(
    subprocess.run(["xcrun", "simctl", "list", "devices", "available", "-j"],
                   check=True, capture_output=True, text=True).stdout
)["devices"]


def version(runtime):
    parts = runtime.rsplit(".", 1)[-1].split("-")[1:]
    return tuple(int(part) for part in parts if part.isdigit())


for runtime in sorted((r for r in devices if ".iOS-" in r), key=version, reverse=True):
    if version(runtime) < (26,):
        continue
    for device in devices[runtime]:
        if f".{family}-" in device.get("deviceTypeIdentifier", ""):
            print(f"id={device['udid']}")
            sys.exit(0)
sys.exit(f"No {family} simulator with iOS 26 or later is available.")
