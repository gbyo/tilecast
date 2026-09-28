# CI timing record

## Before the change

The following successful runs validate the extension PR at commit `5b19d044e534efdc68e814bf3631c75c6d7e73a3`. Both runs started on 2026-09-28 at 06:17:26 UTC:

- [PR validation run 36385719535](https://github.com/gbyo/tilecast/actions/runs/36385719535)
- [Edge run 36385719698](https://github.com/gbyo/tilecast/actions/runs/36385719698)

| Job                           | Execution time |
| ----------------------------- | -------------: |
| Studio                        |         4m 56s |
| Server                        |         3m 55s |
| Production container          |         2m 41s |
| Demo Mode smoke               |         3m 14s |
| Widget validation and visuals |         1m 51s |
| Edge migration                |        15m 55s |
| Edge real-server              |        13m 18s |
| Edge activity parity          |        11m 23s |
| Edge WPE                      |         5m 20s |
| Edge Rust                     |         4m 44s |
| Edge renderer conformance     |         4m 10s |

PR validation completed in 5m 34s. Edge completed in 16m 41s. These durations include runner queue time. The scripts report execution time for each job separately.

## Selection comparison

For a server change outside player protocol or activity paths, the old Edge workflow selected all seven deep jobs. The new graph selects none of those jobs. For a player protocol change, the new graph selects Rust, runtime, WPE, renderer conformance, and real-server tests. It selects migration only for installer, update, or migration changes. It selects activity parity for activity changes.

For a Studio component change, the old PR workflow selected plugin conformance and built the same production image in separate container and Demo Mode jobs. The new graph selects Studio and Demo Mode. Demo Mode includes production image validation and 22 visual states.

Shared Widget renderer changes now explicitly select WPE and Electron conformance. This selection increases integration confidence where the previous Edge path filter could miss a direct Widget change.

After-change run measurements are recorded after the PR validation jobs complete. Do not treat a synthetic selection comparison as a measured speed improvement.
