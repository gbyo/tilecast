# Playback Plan evidence

`apps/server/internal/playbackplan` selects playback evidence for an instant.
The management API exposes this evidence at
`GET /api/v1/screens/{id}/playback-plan`. Studio shows this evidence in the
Screen Overview.

## Studio inspection

The Playback card shows Expected now with a source badge: Takeover, Show
Now, Schedule, or Default. It also shows the default content that plays when
nothing overrides it. The Schedule card shows the active schedule, a truthful
Next row, and the other content schedules. Display-control schedules stay out
of content selection. These decisions come from the API. Studio does not
evaluate precedence or capability compatibility.

Next never treats the boundary as a change. Studio reads the current plan,
then reads the plan at `nextEvaluationAt` through a separate query key. It
compares the two selections. It shows a change only when the authority
selects different content at the boundary. It shows the boundary alone when
the second read fails.

Why this opens the explanation panel. It lists Takeover, Show Now, schedule,
and default candidates in stable precedence order with status badges and
reasons. It traces the selected playlist or layout through its content path.
It does not show synchronization or capability evidence. That evidence lives
in the Diagnostics Playback tab with manifests, downloads, renderer state,
and Widget support.

The current inspection refreshes every ten seconds. A specified instant uses
a separate Screen query key and does not poll. Screen invalidation includes
both current and specified-instant inspections. Query cancellation reaches
the typed transport. A loading or failed request does not display another
instant's cached evidence.

The time picker and displayed dates use the browser time zone. The panel
states that time zone. The shared calendar includes the next ten years when
the caller does not set a date ceiling. An explicit ceiling controls calendar
navigation and date selection. Use server time removes the explicit instant. A past
request shows recorded expectation or a gap. It does not resolve today's
content names. The Activity link opens Player-confirmed observed evidence.
Expected selection does not prove actual playback.

## Management API

The route requires management authentication, the `read` scope, and access to
the Screen. A Player credential does not authorize inspection. Use one `at`
query parameter with an RFC 3339 instant and a time zone. Omit `at` to use
captured server time. The route rejects duplicate, empty, invalid, and unknown
query parameters with `invalid_playback_plan_instant` and HTTP 400.

The success envelope contains `screenId`, `at`, `evaluatedAt`, and `basis`.
Exactly one of `current` and `historical` is present. The current branch
contains selection, candidates, optional `nextEvaluationAt`, synchronization,
and capability assessment. Schedule candidates retain priority, target
specificity, interval, and the scheduling authority's reason. Temporary
presentations do not erase that schedule evidence.

Selected content includes its current name when the resource exists. A
playlist includes its current revision. A Layout includes its published
revision. An asset has no common presentation revision. Missing resources
have no current name or revision. These reads use the same snapshot as
selection. Schedule names also come from that snapshot.

The historical branch contains an optional recorded expectation. A gap is
HTTP 200 with `historical_expectation_unavailable`. Overlapping recorded
windows return `playback_expectation_ambiguous` and HTTP 409. The route does
not guess a winner. A missing or inaccessible Screen returns HTTP 404.
An existing Screen without manifest state also returns HTTP 404 for current
inspection. Inspection does not initialize that state.

The typed contract is in [core OpenAPI](openapi/core.yaml).

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
presentation. `SnapshotCurrent.At` binds the assignment, schedule, Quick
Present, and Takeover readers to one read-only, repeatable-read transaction.
Concurrent configuration changes do not change that snapshot. A later
inspection reads the committed changes. Disabled schedules remain inactive
alternatives in the explanation and do not create evaluation boundaries.

`Current.At` remains the deterministic composition entry point for supplied
readers. Production inspection uses `SnapshotCurrent.At` to obtain consistent
selection, synchronization, and capability evidence. The snapshot does not
reserve configuration for a later mutation. A mutation must validate its own
current transaction state.

Synchronization uses the assignment authority's manifest-version comparison.
It describes the latest reported state at inspection time. It does not prove
content readiness or successful playback. Future predictions use that same
current reported state.

Capability assessment uses the assignment validator's Widget requirement
graph, renderer choice, and reported Player profile in the same transaction.
An unreported profile does not mean reported unsupported capability. Nested
requirement `supported` values are null until the Player reports a profile.
Missing or unpublished selected content remains selected. Its capability
assessment is `unavailable` with a stable reason. Invalid presentation
requirements also return an unavailable assessment. Database errors remain
errors. Inspection does not select alternative content to hide these limits.

This API does not establish content health, a dependency inventory, device
decoder behavior, content readiness, or observed playback.

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
