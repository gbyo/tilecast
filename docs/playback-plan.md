# Playback Plan evidence

`apps/server/internal/playbackplan` selects playback evidence for an instant.
It does not expose an HTTP route or Studio control.

## Inspection basis

`Inspector.Inspect` captures server time once. If the caller omits the instant,
the inspector uses that captured time. An instant before the captured time
uses `History.RecordedAt`. An instant at or after the captured time uses
`Current.At`. The response includes the requested instant and evaluation time.
It contains exactly one current or historical evidence branch.

A historical gap returns `historical_expectation_unavailable`. A historical
reader error remains an error. Neither result evaluates current configuration
as a substitute. A current reader error does not use historical evidence as
a substitute.

## Current configuration

`Current.At` composes existing readers for assignment, schedule explanation,
Quick Present, and Takeover selection. The source order is Takeover, Quick
Present, schedule, then assignment. Display-control schedules do not select
content. The response retains the scheduling authority's candidate reasons.

The next evaluation time is the earliest schedule transition or active
temporary-presentation expiry. It does not guarantee a change in selected
content. Inspection does not initialize manifest state or expire a temporary
presentation. These readers do not use a shared database snapshot. This
selection foundation does not establish content health, dependencies,
Player compatibility, or observed playback.

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
