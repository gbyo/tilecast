# Screen access

Roles are organization-wide. A capability such as `screen.manage` says what an
account may do. Screen access says which screens the account may do it to. A
district with four buildings or a library with branches uses screen access to
give each operator only their own screens.

The Server decides screen access in one place: `apps/server/internal/authz`.
Dashboard routes, Studio package-service calls, and plugin routes ask the same
functions. See [Access control](access-control.md) for the capability side.

## The policy

Each non-Owner account has one explicit screen access policy:

| Field    | Values              | Meaning                                                    |
| -------- | ------------------- | ---------------------------------------------------------- |
| `mode`   | `all`, `restricted` | Every screen, or only the screens that the grants reach.   |
| `scopes` | grants              | Locations and Display Groups, when `mode` is `restricted`. |

The policy is a row in `user_screen_access`. The grants are rows in
`user_screen_scopes`.

### Rules

- **The mode is explicit.** The Server reads the mode from the policy row. The
  Server never infers the mode from the number of grants.
- **A missing policy reaches nothing.** An account without a policy row reaches
  no screen, even when grant rows exist.
- **Restricted with no grants reaches nothing.** An empty grant list never means
  the whole fleet.
- **The Owner reaches every screen.** The Server does not read the Owner policy.
  An installation must not be able to lock itself out of its own fleet.
- **A grant is a location or a Display Group.** A restricted account reaches a
  screen when the screen is in a granted location, or when the screen is a
  member of a granted Display Group.
- **Nobody changes their own screen access.** The Server refuses with
  `403 cannot_scope_self`.
- **Delegation.** An account with restricted access may grant only `restricted`
  access, and only locations and Display Groups granted to it directly
  (`403 screen_scope_delegation`). A Display Group that the account reaches
  only through its members is not delegable, because the group can get members
  that the account cannot reach.

## Containers

A Display Group, a schedule, a takeover, a Quick Present, an AirPlay Present
session, and an update deployment contain screens. A restricted account reaches
a container only through a concrete anchor. **An empty container has no anchor.
The Server refuses it.** An empty set never authorizes an operation.

| Container         | A restricted account reaches it when                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Display Group     | The group is granted directly, or the group has at least one member and the account reaches every member.  |
| Schedule          | The schedule has at least one target, and the account reaches every target screen and target group.        |
| Takeover          | The takeover reaches at least one screen, and the account reaches every screen that it reaches.            |
| Quick Present     | The account reaches the target screen and its Display Group peers, or the target group.                    |
| AirPlay Present   | The session has at least one participant, and the account reaches every participant.                       |
| Update deployment | Read: the deployment reaches at least one screen of the account. Cancel: the account reaches every screen. |

A Display Group plays one assignment on every member. An operation that a group
carries to every member also needs the group peers of each named screen. Content
assignment, takeover and schedule targets, Quick Present, AirPlay Present, and
bulk changes use this rule. A screen that shares a group with a screen outside
the access is refused with `403 out_of_scope`.

### Display Group membership

- Adding a screen to a group needs the group and the screen, and the current
  group peers of the screen. Membership must not make a screen reachable to the
  grantees of the group unless the operator reaches the screen.
- Removing a screen needs the group and the screen.
- A new gateway screen needs the screen.
- A restricted account creates a group only with at least one first member.
  `POST /api/v1/screen-groups` takes `screenIds` and writes the group and its
  members in one transaction. A whole-fleet account may create an empty group.

### Stored targets

Some targets are stored and resolved again later: plugin targets
(`targets.resolve@2`, external Player plugins, Countdown Bar, and Emergency
Alerts). Their groups and locations can get members later. A restricted account
may name screens that it reaches, and only groups and locations granted to it
directly. It may not select all screens. The Server authorizes the stored target
and the new target in the same transaction as the write.

## Organization structure

Locations and Presentation Network definitions are organization structure. A
change to them changes what other accounts reach.

- Creating, renaming, and deleting a location needs `screen.locations.manage`
  and access to every screen.
- Creating, changing, deleting, and replacing the screen set of a Presentation
  Network needs `screen.networks.manage` and access to every screen.
- A restricted account with the capability receives
  `403 screen_access_restricted`.
- `screen.manage` alone does not give either authority.
- Moving a screen to a different location needs a location granted directly to
  the account. A restricted account cannot clear the location of a screen
  (`422 screen_location_required`).

Reads are narrowed. `GET /api/v1/locations` returns, for a restricted account,
the granted locations and the locations of reachable screens. Each screen count
counts only reachable screens. `GET /api/v1/presentation-networks/{id}` returns
only the assignments of reachable screens. A restricted operator with
`screen.manage` can assign a network to one reachable screen with
`PUT /api/v1/screens/{id}/presentation-network`.

## Pairing

Pairing approval decides the destination inside the approval transaction.

| Approval                 | A restricted account needs                                                        |
| ------------------------ | --------------------------------------------------------------------------------- |
| New screen               | A `locationId` granted to it directly. A Display Group grant is not enough.       |
| Restored archived screen | The same as a new screen. Revocation removed the old anchor.                      |
| Credential repair        | The existing screen.                                                              |
| Hardware replacement     | The replacement screen. An unknown or unreachable `replacementScreenId` is `404`. |

- `GET /api/v1/screens/pairing/pending` returns, for a restricted account, only
  sessions from hardware paired to a live screen that the account reaches. New
  hardware has no anchor until an approval names a destination.
- `POST /api/v1/screens/pairing/resolve` resolves a code for new hardware, and
  for hardware paired to a reachable screen. Holding the code is the anchor for
  new hardware.
- A restricted account may reject only a session from hardware paired to a
  reachable screen.
- A whole-fleet account pairs without these restrictions.
- `POST /api/v1/screens/browser` creates a Browser Player screen. It follows the
  new-screen rule.

## Answers

- An object outside the access answers `404` with the not-found code of its
  route, for example `404 screen_not_found`. The answer is the same as for an
  object that does not exist.
- A selection with at least one object outside the access answers
  `403 out_of_scope`. The Server changes nothing.
- A restricted account that names no screen and no group answers
  `403 out_of_scope`.
- A role without the capability answers `403 insufficient_role`.

## Lists

Every list uses the same predicate as the direct decision for its kind.
`GET /screens`, `GET /screen-groups`, `GET /schedules`, `GET /takeovers`,
`GET /presentation-overrides`, `GET /update-deployments`, `GET /locations`, and
the pending pairing list cannot show an object that the direct route refuses.
Archived screens are hidden from a restricted account, because revocation
removed their location and group.

## Revocation and transactions

The Server resolves the policy on every request. A change applies to the next
request of every session, personal access token, and OAuth grant of the
account. Pairing approval, Browser Player creation, Display Group creation, and
plugin target writes decide inside their own transaction and hold the policy row
`FOR SHARE`. A policy change waits for such a transaction. Other operations
decide at the start of the request. A revocation that commits during such a
request applies to the next request.

## Package services and plugins

A Studio package-service call acts for the signed-in operator. It gets the same
capability check and the same `authz` decision as the matching dashboard route.
A background call acts for the installation under the install-time grant of the
package. The call context decides which applies. A Studio call without an actor
is refused. It never runs as a background call. See
[Package services](package-services.md).

A bundled plugin route receives `Host.ScreenAccess`. A plugin that stores screen
targets calls it inside its write transaction for the stored target and the new
target. See [Plugin API](plugin-api.md).

## Route declarations

Every dashboard route below a screen-domain path declares its object rule in
`objectRules` in `apps/server/internal/httpapi/authorization.go`. The dashboard
router applies the rule after the capability, CSRF, and credential-scope checks.
The Server does not start when a screen-domain route has no rule.
`TestScreenRoutesDeclareObjectAuthorization` and `TestEveryObjectRuleDecides`
keep the table and the routes in agreement.

## Migration

Migration `00131_screen_access_policy.sql` creates `user_screen_access` and
writes one row for every account:

- An account with no grant rows gets `all`. That was its access before.
- An account with grant rows gets `restricted` with the same grants.
- The Owner gets `all`, and the Owner rule continues to apply.

The migration `Down` section deactivates each non-Owner account that is
`restricted` with no grants, because the previous schema reads no grants as the
whole fleet.

`POST /api/v1/users` takes `screenAccess`. When a client omits it, the Server
creates the account as `restricted` with no grants. Studio always sends it.
`PUT /api/v1/users/{id}/screen-scopes` requires `mode`
(`422 screen_access_mode_required`).

## Known limitations

- **Historical Activity reporting is not narrowed.** Proof of play, uptime,
  compliance, incidents, screen events, and the audit log cover the whole
  installation for every account with the Activity capability. The overview,
  the fleet health card, and the per-screen Activity routes are narrowed. Do not
  use screen access as a confidentiality boundary for historical reporting.
  Give a restricted operator a role without `activity.read` when this matters.
- The Presentation Network list returns organization facts: network names and
  security types, never credentials.
- One installation serves one organization. Screen access is not a tenancy
  boundary.
