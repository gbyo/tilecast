# Access control

Tilecast decides what an account may do with three separate things:

- A **capability** names one kind of work, for example `media.upload`.
- A **role** is a named set of capabilities. Each account has one role.
- A **scope** narrows where an account may use its capabilities. Tilecast has
  two scopes: [screen scopes](screen-scopes.md) and content access (this
  document).

A role says what an account may do. A scope says where. An action succeeds
only when the role grants the capability and the scope covers the resource.

Studio shows and hides controls from the same data. The Server decides every
request again. Hiding a control is a convenience and never a security boundary.

## Capabilities

The Server defines the capability vocabulary in
`apps/server/internal/auth/capabilities.go`. The vocabulary is closed. A
database row, a request, or a plugin cannot add a capability. The Server
ignores a stored capability string that is not in the vocabulary.

Each capability names a kind of work that an operator recognizes. The set is
coarse on purpose. A capability that needs another capability lists it as a
requirement. For example, `media.upload` needs `media.read`.

`GET /api/v1/roles/capabilities` returns the vocabulary with the group,
requirements, and delegation flags of each entry.

### Built-in roles

The five built-in roles are protected. Their capability sets are in code, not
in the database. An upgrade that adds a capability gives it to the built-in
roles in a predictable way. No account can edit a built-in role.

| Capability                 | Owner | Administrator | Editor | Contributor | Viewer |
| -------------------------- | ----- | ------------- | ------ | ----------- | ------ |
| `media.read`               | yes   | yes           | yes    | yes         | yes    |
| `media.upload`             | yes   | yes           | yes    | yes         | -      |
| `media.edit`               | yes   | yes           | yes    | yes         | -      |
| `media.organize`           | yes   | yes           | yes    | yes         | -      |
| `media.tags.assign`        | yes   | yes           | yes    | yes         | -      |
| `media.archive`            | yes   | yes           | yes    | -           | -      |
| `media.delete`             | yes   | yes           | yes    | -           | -      |
| `media.folders.manage`     | yes   | yes           | yes    | yes         | -      |
| `media.tags.manage`        | yes   | yes           | yes    | yes         | -      |
| `media.collections.manage` | yes   | yes           | yes    | yes         | -      |
| `widget.read`              | yes   | yes           | yes    | yes         | yes    |
| `widget.edit`              | yes   | yes           | yes    | yes         | -      |
| `widget.delete`            | yes   | yes           | yes    | -           | -      |
| `datasource.read`          | yes   | yes           | yes    | yes         | yes    |
| `datasource.edit`          | yes   | yes           | yes    | yes         | -      |
| `datasource.manage`        | yes   | yes           | yes    | -           | -      |
| `playlist.read`            | yes   | yes           | yes    | yes         | yes    |
| `playlist.edit`            | yes   | yes           | yes    | yes         | -      |
| `playlist.publish`         | yes   | yes           | yes    | -           | -      |
| `playlist.delete`          | yes   | yes           | yes    | -           | -      |
| `layout.read`              | yes   | yes           | yes    | yes         | yes    |
| `layout.edit`              | yes   | yes           | yes    | yes         | -      |
| `layout.publish`           | yes   | yes           | yes    | -           | -      |
| `layout.delete`            | yes   | yes           | yes    | -           | -      |
| `campaign.read`            | yes   | yes           | yes    | yes         | yes    |
| `campaign.edit`            | yes   | yes           | yes    | -           | -      |
| `campaign.publish`         | yes   | yes           | -      | -           | -      |
| `content.review`           | yes   | yes           | yes    | -           | -      |
| `screen.read`              | yes   | yes           | yes    | yes         | yes    |
| `screen.manage`            | yes   | yes           | -      | -           | -      |
| `screen.pair`              | yes   | yes           | -      | -           | -      |
| `screen.assign`            | yes   | yes           | -      | -           | -      |
| `schedule.read`            | yes   | yes           | yes    | yes         | yes    |
| `schedule.edit`            | yes   | yes           | -      | -           | -      |
| `activity.read`            | yes   | yes           | yes    | yes         | yes    |
| `activity.audit`           | yes   | yes           | yes    | -           | -      |
| `activity.manage`          | yes   | yes           | -      | -           | -      |
| `plugins.use`              | yes   | yes           | yes    | yes         | yes    |
| `plugins.manage`           | yes   | yes           | -      | -           | -      |
| `users.manage`             | yes   | yes           | -      | -           | -      |
| `roles.manage`             | yes   | yes           | -      | -           | -      |
| `settings.manage`          | yes   | yes           | -      | -           | -      |
| `system.manage`            | yes   | yes           | -      | -           | -      |
| `system.backups`           | yes   | -             | -      | -           | -      |
| `integrations.manage`      | yes   | -             | -      | -           | -      |
| `player.releases`          | yes   | -             | -      | -           | -      |

The matrix is generated from `apps/dashboard/src/test/builtin-capabilities.json`.
A Go test fails when that fixture differs from the Server definition.

Each built-in role keeps the authority it had before capabilities existed. One
authority change is deliberate: before capabilities, the audit API returned the
whole audit log to a Contributor, although Studio hid it. A Contributor now has
no `activity.audit`, so the audit API refuses the request.

Three capabilities are Owner-reserved: `system.backups`, `integrations.manage`,
and `player.releases`. Only the built-in Owner role holds them. A custom role
cannot include them.

## Custom roles

An Owner or an account with `roles.manage` creates custom roles in
**Settings**, **Roles**, or with `POST /api/v1/roles`.

- A custom role has a stable key that starts with `custom.`. The Server derives
  the key from the name one time. A rename does not change the key.
- The name has 2 to 60 characters. The description has at most 280 characters.
  The name must not match a built-in role.
- The role lists capabilities from the vocabulary. The Server rejects an
  unknown capability, an Owner-reserved capability, and a set that omits a
  requirement.
- A role that has accounts cannot be deleted (`role_in_use`).
- A built-in role cannot be changed or deleted (`role_protected`).

A change to a role applies to the next request of every account on the role.
This includes open sessions and personal access tokens. The Server resolves
capabilities from the live role on every request and does not store them in a
session.

### Delegation

An account must not give another account more authority than it holds.

- The Owner may grant any capability that is not reserved.
- Another account may put only capabilities it holds itself in a role.
- No account except the Owner may grant `users.manage` or `roles.manage`.
  These capabilities administer access. This keeps the existing rule that only
  an Owner can create another Administrator-level account.
- Only the Owner may assign the built-in Owner and Administrator roles.
- An account may assign a role only when the role is within what the account
  may grant. The refusal code is `role_delegation`.
- No account may change its own role (`cannot_change_own_role`), its own
  content access, or its own screen scope (`cannot_scope_self`).
- The last active Owner cannot be removed, deactivated, or demoted
  (`last_owner_required`).

## Content access

Content access narrows which part of the Media library an account reaches. Each
non-Owner account has one explicit policy:

| Field         | Values              | Meaning                                                  |
| ------------- | ------------------- | -------------------------------------------------------- |
| `libraryMode` | `all`, `restricted` | The whole library, or only the granted folders.          |
| `tagMode`     | `all`, `restricted` | Any tag, or only the granted tags, may be applied.       |
| `folderIds`   | folder IDs          | The granted folders, when `libraryMode` is `restricted`. |
| `tagIds`      | tag IDs             | The granted tags, when `tagMode` is `restricted`.        |

### Rules

- **A missing policy grants nothing.** Tilecast does not use the rule "no rows
  means everything". An account with no policy row sees no media. Migration
  `00129` writes `all` and `all` for every existing account, so an upgrade
  changes nobody's access.
- **The Owner is never restricted.** The Server does not read the Owner policy.
- **A folder grant covers the folder and every descendant.** Grants form a
  union.
- **An asset with no folder is outside every restricted policy.**
- **Tags are not visibility.** A restricted account never gains an asset
  because the asset has an allowed tag. A tag grant lets the account add and
  remove that tag on assets it can already reach.
- **One predicate decides everything.** `media.AssetInScopeSQL` is the single
  definition of "this asset is in the account's scope". Lists, counts, searches,
  facets, details, thumbnails, previews, the archive, and every mutation use it.
  The library an account sees and the assets it can change cannot disagree.
- **Out-of-scope reads answer `404`.** A direct request for an asset, folder,
  or tag outside the scope answers not found, like a resource that does not
  exist. A restricted account cannot learn what exists outside its folders.
- **A bulk request is all or nothing.** If one asset is outside the scope, the
  Server changes nothing and answers `404`. The same rule applies to a tag the
  account may not apply (`tag_not_assignable`).
- **Restructuring needs the whole library.** Creating, renaming, moving, or
  deleting folders and collections needs `libraryMode` `all`. Creating,
  renaming, or deleting tags needs `tagMode` `all`. A restricted account that
  attempts this receives `content_scope_restricted`. Folder ancestry is
  security-relevant. A scoped account must not reshape it.
- **Widgets and websites share the asset table.** The type of an asset also
  follows the role: `media.read` reads images and videos, and `widget.read`
  reads Widgets. A restricted account cannot create a Widget or website,
  because a new Widget has no folder.

Content access is a management boundary. The Player, the manifest, and
tag-driven playlists resolve the whole library. A tag playlist keeps every
legitimate asset, whoever last edited it.

### Granting access

Open **Settings**, **Users**, edit the account, and open **Content access**. An
account with `users.manage` may grant only folders and tags it can reach itself
(`content_access_delegation`).

The API is `GET` and `PUT /api/v1/users/{id}/content-access`. The response
includes `configured`, which is false when the account has no policy.

### Effective access of the signed-in account

`GET /api/v1/me/access` returns the role, the effective capabilities, the
content modes, and `writableFolderIds` for a restricted account. Studio reads
it to choose navigation, controls, and upload destinations. The auth status
(`GET /api/v1/auth/status`) also lists the effective capabilities.

## Uploads

An asset must never exist outside the uploader's scope, even for a moment. The
upload contract therefore carries the destination.

- `POST /api/v1/uploads` accepts an optional `folderId`. The Server stores it on
  the upload session.
- An account with `libraryMode` `all` may omit `folderId`. The asset is then
  created at the library root.
- An account with `libraryMode` `restricted` must name a granted folder. The
  Server answers `422` `upload_folder_required` when `folderId` is missing. It
  answers `404` when the folder does not exist or is outside the scope.
- The Server authorizes the folder when it creates the session. It authorizes
  the folder again, inside the database transaction that creates the asset,
  after it takes a share lock on the policy row. A revocation that starts
  during a long upload takes effect. A concurrent revocation waits for a
  registration that already passed the check.
- The client does not repeat the folder at completion. The Server uses the
  stored value.
- The account that started an upload may always cancel it, even after a
  revocation.

Studio selects the folder when the account has exactly one writable folder. It
shows a chooser when the account has several. It explains an account with
none. The iOS app sends `folderId` in the `system/media-intake` request
(see [iOS app](ios-app.md)).

## Screen access

Screen scopes are unchanged. See [screen-scopes.md](screen-scopes.md). A role
grants the screen capability. A screen scope narrows the screens.

## Bearer credentials

A personal access token and an OAuth grant act as the live user. The Server
resolves the user, the role, the capabilities, and the content access on every
request. The credential scopes `read`, `write`, and `admin` are an additional
ceiling. A credential never grants a capability the user lacks. A credential
scope never grants more than the role.

## Plugins

`plugin.Principal` carries the effective core capabilities and exposes
`Principal.Can(capability)`. Plugin routes require `plugins.use`. Every
built-in role has `plugins.use`, so an existing plugin page stays visible. A
custom role gets plugin pages only when its capability list includes
`plugins.use`. Plugin configuration needs `plugins.manage`.

`Principal.CanManage()` reports `plugins.manage`. Do not compare `Principal.Role`
to a role name.

The Forms plugin keeps its own per-form grant lattice. Core capabilities decide
whether an account reaches the Forms area. Forms then enforces its form-level
grants. The capabilities are not merged.

## Studio

Studio reads `capabilities` from the auth status. Each route handle declares the
capabilities it needs. The sidebar, the native navigation catalog, command
search, Settings sections, and a route guard all read that one declaration.

An account whose role has only Media capabilities lands in Media. It sees Media
and its own account pages. It does not see Fleet, Display Groups, Widgets, Data
Sources, Playlists, Layouts, Campaigns, Schedules, Activity, Plugins, or
installation Settings.

Studio code must test a capability with `useCapabilities().can(...)`. Do not
compare a role name for authorization. The Owner identity checks are the only
exception.

## Compatibility and migration

Migration `00129_rbac_roles_and_content_access.sql`:

- creates the `roles` and `role_capabilities` tables and inserts the five
  built-in roles,
- replaces the fixed `users.role` check with a foreign key to `roles`, so a
  custom role cannot be deleted while an account holds it,
- creates `user_content_access` and the folder and tag grant tables, and writes
  an `all` policy for every existing account,
- adds `upload_sessions.destination_folder_id`.

The `role` field of the user API changes from a fixed list to a role key. The
five earlier values stay valid. Existing sessions, personal access tokens,
OAuth grants, audit attribution, CSRF, multi-factor authentication, Content
Review, and Player authentication are unchanged.

The migration `Down` section moves accounts on a custom role to Viewer.

## Known limitations

- Activity reporting is not scoped by content access or screen access. See
  [screen-scopes.md](screen-scopes.md).
- Content access does not scope Widgets, Data Sources, playlists, or Layouts.
  It scopes the Media library. A role without the related capability has no
  access to those areas.
- Collections are library-wide. Only an account with the whole library can
  create or change them.
- Branding uploads in **Settings** need the whole library, because they land at
  the library root.
- One installation serves one organization. Roles and scopes are not a tenancy
  boundary.
