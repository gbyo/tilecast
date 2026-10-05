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

## Measured Edge comparison

[Edge run 36390934624](https://github.com/gbyo/tilecast/actions/runs/36390934624) passed all seven deep jobs at commit `af6ebe41e23e72265deefadef18f963429fea49f`. It used the new dependency graph, required aggregate, and image cache targets.

| Measurement                   |  Before |   After |
| ----------------------------- | ------: | ------: |
| Full Edge elapsed time        | 16m 41s | 17m 17s |
| Full Edge job execution total | 55m 31s | 52m 52s |
| Migration                     | 15m 55s | 15m 53s |
| Real server                   | 13m 18s |  13m 9s |
| Activity parity               | 11m 23s | 10m 33s |
| WPE                           |  5m 20s |  4m 49s |
| Renderer conformance          |  4m 10s |  2m 32s |

The full Edge run used 159 fewer job execution seconds. Its elapsed time increased by 36 seconds. These two runs do not establish a cache speed trend. They confirm that all deep validation still runs successfully.

A second full [Edge run 36393103397](https://github.com/gbyo/tilecast/actions/runs/36393103397) passed at commit `e9d6ac6b2d4114c1578ee6b2e319ecd21d3e25af`. It completed in 15m 19s and used 51m 37s of job execution time. The two after-change runs show why one elapsed duration is not a reliable cache speed estimate.

## Android Gradle cache observation

The Android workflow already enables Gradle dependency caching through `actions/setup-java` and task-output caching plus parallel execution through `apps/player-android/gradle.properties`. Two successful Android CI jobs provide a cold/warm observation:

| Run                                                                             | Gradle tasks                                                                    | Android job duration | Gradle task step |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------: | ---------------: |
| [PR run 36720401406](https://github.com/gbyo/tilecast/actions/runs/36720401406) | No restored Gradle cache or `FROM-CACHE` task results in the log                |               5m 27s |           4m 34s |
| [PR run 36720998841](https://github.com/gbyo/tilecast/actions/runs/36720998841) | Restored Gradle caches; Kotlin compilation and unit tests reported `FROM-CACHE` |               1m 12s |              20s |

These runs used separate pull request jobs, so this is an observed comparison rather than a controlled benchmark. The Android workflow now also runs the same validation tasks twice and enables configuration cache with problems set to fail. The second invocation checks that Gradle can reuse its configuration cache. This PR's CI result will establish whether the configuration cache is compatible with the current Android build.

The main reduction comes from selection. Ordinary server administration changes select zero deep Edge jobs. The old workflow selected the full matrix for these changes. The after-run matrix used 52m 52s of job execution time. This is an example of the work that selection avoids, not a measured duration for a targeted PR. Studio component changes also select zero deep Edge jobs. The old Edge path filter already excluded these changes.

The production browser job now includes 14 functional tests and 22 Studio visual comparisons. Studio also collects V8 coverage. The workload differs from the old smoke job, so a full PR comparison must include these extra checks. [PR 739](https://github.com/gbyo/tilecast/pull/739) records the final baseline-inclusive PR run and its elapsed and job execution times. Do not treat a synthetic selection comparison as a measured speed improvement.

## Server test package parallelism

On 2026-09-30, the full server CI test command ran locally against PostgreSQL 18.6 (Homebrew) on macOS. Both runs used the same checkout, a warm Go build cache, and `-count=1` to disable Go's test-result cache. The command covered 54 packages and 748 tests, including temporary database setup and cleanup.

| Package setting | Wall time | Result             |
| --------------- | --------: | ------------------ |
| `-p 1`          |   15.03 s | 54 packages passed |
| Go default      |    3.24 s | 54 packages passed |
| `-p 8` repeat   |    2.67 s | 54 packages passed |

These local runs show that package-level parallelism reduced elapsed time on this host. They do not predict GitHub runner timing. Each measured run executed the tests with result caching disabled.
