#!/usr/bin/env python3
"""Pairs each `send <phase> T` line with the next unused `glass <phase> G`
line and prints the delay statistics in milliseconds. A glass line serves one
change only, and a delay of a whole phase or more counts as missed, not as a
short delay. The sender's changes are paired first, and then the first WARMUP
changes are left out: the receiver needs an IDR frame and its pipeline to
start.

The colours carry no sequence number, so a steady delay of a whole phase or
more cannot be told from a start that missed its first changes. Run the
spike with a delay far below one phase (the target is 300 ms)."""
import statistics
import sys

WARMUP = 4
PHASE_US = 1_000_000  # the sender holds each colour for one second


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
    sent = events(sender, "send")
    seen = events(receiver, "glass")
    taken = [False] * len(seen)
    paired = []
    for phase, at in sent:
        index = next((i for i, (p, g) in enumerate(seen) if not taken[i] and p == phase and g >= at), None)
        if index is None or seen[index][1] - at >= PHASE_US:
            paired.append(None)  # no frame, or one that a later change may own
        else:
            taken[index] = True
            paired.append((seen[index][1] - at) / 1000)
    paired = paired[WARMUP:]
    delays = [delay for delay in paired if delay is not None]
    missed = len(paired) - len(delays)
    sent = paired
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
