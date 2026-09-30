# Screen scopes

Roles are organization-wide. Everyone who can operate screens can operate all of
them, which does not fit a district with four buildings or a library with
branches.

A screen scope narrows one account to named locations and sync groups.

## What is scoped

Scope applies to **screen operations**:

- assigning and removing content
- takeovers
- player commands
- enabling and disabling playback
- player policy and reliability
- bulk changes
- update deployments
- Display Group and Schedule reads/changes that resolve to screens
- Takeover and Quick Present reads/stops
- reading a screen, its status, its commands, and its policy

Scope does **not** apply to the content library. A scoped account still sees and
edits every playlist, Layout, Widget, Data Source, and media file. A shared
library is the point of a shared library, and scoping content is a separate and
larger decision.

## The rules

- **No grants means the whole fleet.** That is what every account has after this
  feature ships, so an upgrade changes nobody's access. Narrowing is opt-in, per
  account.
- **An Owner is never scoped.** An installation must not be able to lock itself
  out of its own fleet.
- **Nobody can change their own scope.** Otherwise a scoped administrator could
  only widen themselves.
- **A grant is a location or a sync group.** A screen is in scope when its
  location matches, or when it belongs to a scoped group.
- **All or nothing on a set.** An operation naming screens outside the scope is
  refused rather than quietly applied to the subset. A bulk change that silently
  dropped screens would report a change count nobody asked for.

## Setting a scope

Open **Settings**, **Users**, edit the account, and choose locations or sync
groups under **Screen scope**. Selecting none restores whole-fleet access.

An Owner or Administrator sets scope, under the same role hierarchy that governs
editing the account at all.

## What a scoped account sees

An out-of-scope screen answers `404 screen_not_found`, not `403`. A scoped
operator has no business learning which screens exist outside their scope.

An operation naming a mix of in-scope and out-of-scope screens answers
`403 out_of_scope`.

The screen list is filtered by the same predicate that authorizes each
operation, so the list a person sees and the screens they can act on cannot
disagree.

Resources that resolve to multiple screens follow the same rule. Display Group
and Schedule lists omit resources whose effective screen set is not wholly in
scope; direct reads return not found, and writes refuse targets outside the
scope. Takeover and Quick Present reads/stops are checked against every screen
the session reaches.

Archived screens are hidden from narrowed accounts. Revocation deliberately
detaches a screen from its current location and Display Group, so the archive
no longer has a safe current-scope anchor; returning an installation-wide
archive would reveal screens the caller could not otherwise enumerate.

## Update deployments

A deployment is not a screen. It names a set of screens, and it keeps one row per
screen from the moment it starts, so that set is what a scope is applied to.

- **Reading narrows.** The deployment history and one deployment's detail report
  the caller's screens. Every count is a count of their screens, so the progress a
  wing lead reads is the progress of their wing.
- **Cancelling is all or nothing.** Cancelling stops the deployment on every
  screen it reaches, so a deployment that also covers screens outside the scope
  answers `403 out_of_scope` and nothing is cancelled.
- **A retry is one screen.** Retrying follows the single-screen rule, so an
  operator may retry their own failed screen in a deployment that also covers
  screens they cannot reach.
- A deployment that reaches nothing in scope answers `404`, the same as a screen
  outside the scope.

## Known limitations

- **Activity reporting is not scoped.** Proof of play, incidents, compliance, and
  the audit log still cover the whole fleet. Scope is enforced on operations and
  on the screen list, not on historical reporting. Do not treat a scope as a
  confidentiality boundary for reporting.
- A sync group that straddles two locations is reachable by anyone scoped to
  either, because assigning one member assigns the group. The bulk change preview
  names those screens.
- Pairing a new screen is not scoped: an Owner or Administrator approves
  pairings for the installation.
- Scope is per account. There are no scope templates or groups of scopes.
- One installation still serves one organization. A scope is a convenience
  inside it, not a tenancy boundary.
