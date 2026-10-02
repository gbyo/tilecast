# Playback Plan evidence

`apps/server/internal/playbackplan` reads recorded expected playback evidence.
It does not expose an HTTP route or Studio control.

## Historical expectations

`History.RecordedAt` reads the expected playback window that contains an
explicit instant for one Screen. It uses a read-only, repeatable-read
transaction. The interval includes its start and excludes its end and
supersession instant.

The response preserves the recorded presentation ID, revision, manifest
version, schedule ID, source, time zone, and optional deterministic content
reference. It does not join current assignments, schedules, content names,
dependencies, or Player capabilities. A deleted content or schedule record
does not remove its recorded identity from the response. A current name or
revision is not historical evidence.

| Result                               | Meaning                                                         |
| ------------------------------------ | --------------------------------------------------------------- |
| `recorded_expectation`               | One recorded window contains the instant.                       |
| `historical_expectation_unavailable` | The Screen exists, but no window contains the instant.          |
| `ErrNotFound`                        | The Screen does not exist.                                      |
| `ErrAmbiguousExpectation`            | Two recorded windows contain the instant. No winner is guessed. |

Database and scan errors are errors, not successful responses with missing
evidence. An open recorded window is evidence that an expectation was
recorded. It is not a prediction of future playback or proof that a Player
displayed the content. The caller must distinguish historical inspection from
current or future configuration evaluation.

This domain does not calculate compliance or observed playback. Those metric
definitions remain in [Activity](activity.md) and the
[Activity event contract](activity-event-contract.md). Recorded expected
windows can have gaps; current schedules must not fill those gaps.

The caller must authorize access to the Screen before it returns this
evidence to a user. The domain reader does not replace the existing Screen
scope boundary.
