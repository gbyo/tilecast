# ADR: Plugin capabilities and plugin sessions

Status: proposed. [ADR: Plugin Model V3](plugin-model-v3.md) depends on this
record. The implementation must update `docs/access-control.md`,
`docs/plugin-api-v2.md` or its successor, `docs/api.md`, and the public
access-control pages in the same change.

## Context

### Need

Many plugins need a person to do one narrow thing without broad Studio
access:

- a counter clerk advances a "now serving" queue;
- a scorekeeper runs a game clock;
- a meeting clerk moves the agenda marker;
- a front-desk tablet signs visitors in;
- the public joins a poll or a speaker queue from a phone.

Plugin routes today accept three access levels: `AccessViewer`,
`AccessManager`, and `AccessSession`. Each one needs a Studio account with
`plugins.use` or `plugins.manage`. No access level fits a clerk, a shared
tablet, or an anonymous phone.

### Current access-control rules

- `apps/server/internal/auth/capabilities.go` defines a closed vocabulary.
  "Nothing read from the database or a request can add to it."
- `role_capabilities` stores capability strings for custom roles. The check
  is `^[a-z][a-z0-9_.]{1,63}$`.
- `NewCapabilitySet` drops a string that the vocabulary does not know. A row
  therefore cannot invent authority.
- `normalizeRoleInput` refuses an unknown string when an operator saves a
  role.
- `UpdateRole` deletes every capability row of the role and writes the new
  set.
- Owner-reserved capabilities exist only on the Owner role.
- A non-Owner can grant only capabilities that it holds.

### Reference

Grafana lets an app plugin declare roles and actions in `plugin.json`. The
action names carry the plugin ID as a prefix. Grafana assigns the plugin
roles to its basic roles from a `grants` list in the same file.

## Decision, part 1: plugin capabilities

### Key

- A plugin capability key is `plugin.<identity>.<name>`.
- `<identity>` is the bundled plugin ID, or the package ID of an installed
  package.
- `<name>` matches `^[a-z][a-z0-9_]{0,31}$`.
- A key has at most 128 characters.
- A migration widens the `role_capabilities` check to accept
  `^plugin\.[a-z0-9][a-z0-9._-]{0,126}$` beside the current pattern. Package
  IDs contain hyphens, so the current pattern cannot hold them.
- The Server never parses a key to find its plugin. The definition table
  below maps each key to its plugin.

### Declaration

A plugin manifest declares each capability with:

- `name`;
- `title` and `description`, for the role editor;
- `requires`: other capabilities of the same plugin, or core capabilities.
  `plugins.use` is always required.

A plugin capability is never Owner-reserved. A plugin cannot declare a
capability that administers access.

### Definitions are kept

The Server stores each definition in a new table,
`plugin_capability_definitions`:

| Column                        | Meaning                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `key`                         | Primary key.                                             |
| `plugin`                      | The bundled plugin ID or the package ID.                 |
| `title`, `description`        | The text from the current or last manifest.              |
| `requires`                    | The required capabilities.                               |
| `active`                      | True while an installed plugin version declares the key. |
| `first_seen_at`, `removed_at` | Lifecycle timestamps.                                    |

A definition row is never deleted while a role references the key.

### Lifecycle

| Event                                         | Result                                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install or Server start with a bundled plugin | Each declared key is `active`.                                                                                                                                         |
| Removal                                       | Each key of the plugin becomes inactive. Role rows stay. An inactive key grants nothing.                                                                               |
| Update or rollback without a key              | That key becomes inactive. The update review lists it with the roles that hold it.                                                                                     |
| Update or rollback with a new key             | The key becomes active. No role holds it until an operator grants it.                                                                                                  |
| Installation again                            | Each declared key becomes active again. Role rows regain their effect. The install review lists each role that holds a key of the plugin before the operator confirms. |
| A changed `title` or `description`            | Accepted. The text is presentation.                                                                                                                                    |
| A changed `requires`                          | Accepted only with review. The update review shows the change.                                                                                                         |

**The meaning of a key never changes.** A plugin that needs a different
meaning declares a new key. `pluginctl check` compares bundled keys with the
previous release and refuses a removed or renamed key without a recorded
reason. For installed packages, the update review shows removed keys.

### Resolution

- `ResolveCapabilities` adds active plugin keys from `role_capabilities` to
  the core set. It drops inactive keys and unknown strings, as today.
- **Owner** holds every active plugin capability.
- **Administrator** holds every active plugin capability, because it already
  holds `plugins.manage`.
- Editor, Contributor, and Viewer hold no plugin capability. A manifest
  cannot grant a capability to a built-in role. Built-in roles stay
  predictable.
- An Owner or Administrator grants plugin capabilities to custom roles. The
  delegation rule does not change.

### Role editor

- The role editor shows plugin capabilities in a group for each plugin.
- An inactive key shows as "Inactive: the plugin is not installed." It
  cannot be added.
- Saving a role keeps the rows of inactive keys. `UpdateRole` deletes and
  writes only the rows of active and core keys.
- `normalizeRoleInput` accepts an active plugin key. It still refuses a
  string that has no definition.

### Fixtures

`src/test/builtin-capabilities.json` keeps the core sets of the built-in
roles only. A second generated fixture lists the bundled plugin keys. A Go
test checks that Owner and Administrator hold each of them.

### Use

- A plugin route declares `AccessCapability("<key>")`. The key must be a key
  of the same plugin or a core capability.
- A service operation that a plugin calls in a Studio context checks the
  capability of the actor.
- Studio asks `useCapabilities().can("<key>")`. Hiding a control is still not
  a security boundary.
- Screen access still applies. A plugin capability says what a person can
  do. The screen scope says where.
- A moderation queue names its reviewer capability. The key must be a key of
  the same plugin.

## Decision, part 2: plugin sessions

Three kinds of principal reach plugin pages. Each kind has its own
credential, its own routes, and its own cookie. A credential of one kind is
never accepted on the routes of another kind, on dashboard routes, or on
Player routes.

### Staff

A staff member signs in to Studio as today.

- A plugin page can require a plugin capability.
- A plugin can show a focused operator page with the existing
  `standaloneRoutes` and `topLevel: true`. The page has no Studio
  navigation, so a clerk sees only the keypad.

### Kiosk

A kiosk is a shared device, such as a front-desk tablet or a keypad, that
runs one plugin page without a personal account.

**Enrollment.**

1. An Owner or Administrator creates a kiosk in Studio. The kiosk names one
   plugin, one plugin page, optionally one instance, and a set of capabilities
   of that plugin. The set cannot hold core capabilities.
2. Studio shows a single-use enrollment code as a QR code and as text. The
   code expires after ten minutes.
3. The tablet opens `<public URL>/kiosk/enroll` and submits the code.
4. The Server returns a kiosk cookie. The cookie value is random. The Server
   stores only its SHA-256 hash.

**Rules.**

- Kiosk enrollment has the same rate limit as pairing code resolution.
- A kiosk credential reaches only routes that a plugin declares with
  `AccessKiosk` for the same plugin, and only with the kiosk's capabilities.
- Unsafe kiosk requests need a CSRF token that is bound to the kiosk session.
- Each kiosk action records the kiosk name and the account that created the
  kiosk in the audit event.
- A kiosk expires after at most 365 days. An Owner or Administrator can
  revoke it. Revocation takes effect on the next request.
- Studio lists kiosks with their last use.

### Participant

A participant is an anonymous person who joins one plugin instance from a
phone, for example a poll, trivia, or a speaker queue.

**Joining.**

1. A plugin instance opens participation. The host creates a join code that
   expires when the instance closes participation, or after 24 hours.
2. Screens show the join code as a QR code for `<public URL>/join/<code>`.
3. The phone opens the address. The Server returns a participant cookie with
   a random value. The Server stores only its SHA-256 hash. The session
   expires after 12 hours or when participation closes.

**Rules.**

- Participant routes are below `/api/v1/participate/{pluginId}/`. A plugin
  declares each participant endpoint with a body limit of at most 16 KiB.
- The host applies a rate limit for each participant, for each client
  address, and for the instance.
- The host offers one WebSocket channel for each open instance. The plugin
  sends bounded messages to all participants or to one participant. The host
  delivers participant messages to the plugin asynchronously.
- The host limits the number of participants for each instance. The default
  is 500. An Owner can change it.
- Free text and media from a participant must enter moderation before they
  can reach a screen, as for public webhooks. See section 13a of Plugin
  Model V3.
- A choice from options that the plugin defined, such as a poll vote, can
  reach a screen as an aggregate without moderation.
- A participant has no name unless the plugin asks for one. A name is
  personal data and follows the personal-data rules of Plugin Manifest API 3.
- Participation needs an address that phones can reach. On an installation
  without a public address, only phones on the same network can join. Studio
  shows the address that it will put in the QR code.

### Order

Staff access and plugin capabilities come first. Kiosks come next.
Participant sessions come last, because they add an anonymous public
boundary and a WebSocket fan-out.

## Consequences

- The capability vocabulary stays closed for each running set of plugins. It
  grows only from reviewed manifests.
- A removed plugin leaves inactive rows. They grant nothing and keep each
  role valid.
- Reinstalling a plugin restores earlier grants. The install review shows
  this before the operator confirms.
- Two new credential types exist. Each one needs the same care as the device
  credential: hashed storage, constant-time comparison after lookup, no value
  in a log or a URL after enrollment, and revocation.

## Rejected alternatives

- **Free capability strings in a manifest without stored definitions.** An
  uninstall would turn role rows into data that nobody can explain, and a
  role edit would delete them.
- **A `grants` list that gives plugin capabilities to built-in roles.**
  Built-in roles are protected and defined in code. A plugin must not change
  what a Viewer can do.
- **A shared user account on a kiosk tablet.** The password would be on the
  device, and the account would reach all of Studio.
- **Public webhooks for participants.** They have no session, no rate limit
  for each person, and no fan-out to phones.
