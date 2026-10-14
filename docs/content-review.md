# Draft, review, and publication

Tilecast keeps authoring state separate from what Players can receive. A
Playlist or Layout may have a working draft, an immutable submission under
review, and a different published version at the same time. Editing an object
that is already used by screens changes the draft only; it does not change
those screens.

## Roles and policy

The organization setting `content.review_policy` has three values:

- `off`: a user with publish permission can publish directly.
- `contributors`: Contributor submissions require review; content managers can
  publish their own work directly.
- `everyone`: every publication requires an approved submission.

`content.allow_self_approval` controls whether the submitter may approve their
own submission. It defaults to the compatible existing behavior, enabled.
`content.auto_publish_on_approval` defaults to disabled. When enabled, an
approval publishes immediately unless the submission has a future publication
time, in which case it becomes Scheduled.

The old `content.approval_required` setting is migrated predictably: `true`
becomes `everyone`, and `false` becomes `off`. The old key remains available
for compatibility. Review policy is enforced by the server; hiding a Studio
button is not an authorization boundary.

| Role          | Author drafts | Submit | Review | Publish Playlist/Layout | Publish Campaign |
| ------------- | ------------- | ------ | ------ | ----------------------- | ---------------- |
| Owner         | Yes           | Yes    | Yes    | Yes                     | Yes              |
| Administrator | Yes           | Yes    | Yes    | Yes                     | Yes              |
| Editor        | Yes           | Yes    | Yes    | Yes                     | No               |
| Contributor   | Yes           | Yes    | No     | No                      | No               |
| Viewer        | Read-only     | No     | No     | No                      | No               |

The table shows the built-in roles. Review and publishing follow capabilities:
`content.review` reviews, `playlist.publish` and `layout.publish` publish, and
`campaign.publish` publishes a Campaign. A custom role has these actions when its
capability list includes them. See [access-control.md](access-control.md).

Campaigns use the stricter deployment boundary because publishing one changes
multiple schedules and destinations. Screen scopes still apply to the
existing screen-operation routes.

## Immutable submissions

**Submit for review** snapshots the exact working definition, including the
native/draft revision, full document, and SHA-256 digest. The snapshot is never
re-read from mutable draft rows during review or publication. A submission
moves through:

`in_review` → `changes_requested` or `approved` → `scheduled` or `published`.

Older submissions may become `superseded` or `publication_failed`. Cancelling a
scheduled publication returns that immutable submission to `approved`; it does
not create a separate cancelled submission state. A submission that is still active is unique per content
object, while its immutable record remains available in the submission list.

Authors may continue editing after submitting. If revision 21 is in review and
the working draft advances to revision 22, the reviewer sees that a newer draft
exists, but approving revision 21 is still valid. Publishing it makes exactly
revision 21 live and leaves revision 22 as the next unpublished draft.

Requesting changes requires a note. Approval may include an optional note.
Approving a stale or superseded submission is rejected; a newer working draft
does not make an otherwise active immutable submission stale.

## Publication

Publication validates the frozen snapshot against current readiness and
dependency rules, then commits the runtime change, native revision, publication
history, audit event, and manifest invalidation in one transaction. Player
notifications are sent only after commit. Assignment still performs the
transactional approval/publication gate as defense in depth, including its
revision-row locking against edit/assignment races.

Layouts already had draft and published revisions; their Publish action now
uses the same submission path. A review-required installation cannot publish a
Layout and only then discover that it needs approval.

## Scheduled publication

An approved submission can be scheduled with `requestedPublicationAt`. The
intent is stored in PostgreSQL, not in a process timer. Tilecast reconciles due
submissions at startup and periodically, locks each submission before
publishing, and rechecks its status and due time. A manual publish or
cancellation therefore cannot be duplicated by a second worker. A failed due
publication becomes `publication_failed` with its reason visible in Studio;
there is no unbounded silent retry loop.

## Studio review workspace

Content Review shows explicit submissions in the In review, Approved,
Changes requested, Scheduled, Recently published, and All states. Each entry
includes the title, type, submitter, exact revision, digest, current published
revision, whether a newer draft exists, and the known screen/location impact.
The submission snapshot—not the author's current draft—is the review subject.

The workspace provides Approve, Request changes, Publish, Publish at, and
Cancel schedule actions as permitted by role and policy. History links expose
the semantic comparison against another publication and the separate
Restore as draft and Roll back actions.

## Review versus audit

Content submissions and publication history are recovery/editorial data:
they answer which immutable version was reviewed and what was live. The Audit
Log remains accountability data: who submitted, approved, published,
scheduled, restored, rolled back, or archived an object. Rollback reads a
publication snapshot, but never replays or deletes audit records.

## Migration and limitations

Migration `00095_editorial_workflow.sql` seeds a working Playlist draft from
the current normalized runtime rows and backfills available Playlist and Layout
publication checkpoints. It does not edit runtime rows or bump screen
manifests. Existing review decisions remain readable through the assignment
gate, and existing live content is not made blank solely because it predates
the workflow.

Publication history is bounded only by the existing native revision retention
rules for ordinary Playlist checkpoints. Revisions referenced by the current
publication, an active submission, a scheduled publication, or publication
history are protected from pruning. A deleted media asset is never resurrected
by restore; if a historical snapshot can no longer validate, Tilecast reports
the validation failure instead of publishing an incomplete object.

The legacy `/content-reviews` endpoints remain available for compatibility with
older decision-based clients. New Studio flows use `/content-submissions` and
`/content-history`.
