#!/usr/bin/env python3
"""Pairs `send <phase> T` lines with the next `glass <phase> G` line and
prints the delay statistics in milliseconds. The first WARMUP changes are
left out: the receiver needs an IDR frame and its pipeline to start."""
import statistics
import sys

WARMUP = 4


def events(path, kind):
    found = []
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            parts = line.split()
            if len(parts) == 3 and parts[0] == kind and parts[1] in ("white", "black"):
                found.append((parts[1], int(parts[2])))
    return found


def main():
    name, sender, receiver = sys.argv[1:4]
    sent = events(sender, "send")[WARMUP:]
    seen = events(receiver, "glass")
    delays, missed = [], 0
    for phase, at in sent:
        match = next((g for p, g in seen if p == phase and at <= g < at + 1_000_000), None)
        if match is None:
            missed += 1
        else:
            delays.append((match - at) / 1000)
    if not delays:
        print(f"{name}: no matched changes (sent {len(sent)})")
        return
    delays.sort()
    p90 = delays[min(len(delays) - 1, int(len(delays) * 0.9))]
    print(
        f"{name}: n={len(delays)} missed={missed} median={statistics.median(delays):.1f} "
        f"p90={p90:.1f} min={delays[0]:.1f} max={delays[-1]:.1f} ms"
    )


main()
