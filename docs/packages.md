# Extension packages

An extension package is a distribution container, not a fourth extension
API. It carries distribution, version, provenance, and contribution
metadata for Widgets, declarative Data Sources, and (once the external
runtime exists) plugin behavior. The contribution contracts themselves
(`tilecast.widget.json`, `tilecast.datasource.json`,
`tilecast.plugin.json`) do not change. See
[Content extension model](content-extension-model.md) for the architecture.

## Manifest

`tilecast.package.json` is the manifest. Required fields:

- `apiVersion`: `1` or `2`. Version 1 carries content contributions
  only. Version 2 adds the external runtime module and capability
  requests below.
- `packageId`: qualified identity of two or more dot-separated segments,
  for example `acme.athletics`. The `tilecast` namespace is reserved for
  the release.
- `packageVersion`: strict SemVer, for example `2.4.1`.
- `name`, `description`: human-readable text.
- `publisher`: `id` (one namespace segment) and `name`. The package ID
  starts with the publisher namespace.
- `repository`: public https source repository with a host and path.
- `license`: SPDX identifier such as `MIT`.
- `tilecast.version`: compatibility range as space-separated clauses, for
  example `>=1.2.0 <2.0.0`. Every clause must hold. No OR, ranges, or
  wildcards.
- `distribution.oci`: OCI registry and repository without tag or digest,
  for example `ghcr.io/acme/tilecast-athletics`. The installer resolves it
  to an immutable digest at install time.
- `contributions`: one or more entries of `type` (`plugin`, `widget`, or
  `dataSource`) and `path` (a `./relative` directory inside the package).

Optional fields are `documentation` and `issues` (https URLs). Unknown
fields are rejected: a manifest cannot declare a source or name code to
download. Contribution paths point inside the package and cannot escape
it. Each contribution root is unique across the package, even when the
contribution types differ.

A version 2 manifest may add `runtime` and `capabilities`:

- `runtime.module`: `./relative` path of the WebAssembly module inside
  the package. The module holds the external server behavior.
- `capabilities.network.hosts`: explicit HTTPS hosts the module may
  fetch. No host outside the list is reachable.
- `capabilities.background.jobs`: one to four jobs with `id` and
  `intervalMinutes` (5 to 1440). The server runs each job on its
  interval.
- `capabilities.storage`: `true` requests package-owned key/value
  storage.
- `capabilities.studioUI.entry`: `./relative` self-contained HTML page
  for the sandboxed Studio interface.

Capabilities are requests, not grants. The install review shows every
request before anything installs. Network, background, and storage
requests require a runtime module. The Studio interface may stand
alone. A version 1 manifest requests no capabilities.

Two validators enforce the same rules: the TypeScript validator in
`@tilecast/package-sdk` for authoring time, and the server-authoritative Go
parser in `packages/package-sdk/go`. The fixtures in
`packages/package-sdk/testdata/manifests/` run through both. The portable
JSON Schema is generated from the Zod source with
`npm run packages:generate`.

## Namespaces

Every contribution ID equals its package ID or lives beneath it:
`acme.athletics.scoreboard` belongs to `acme.athletics`, while
`acme.athletics2` does not. One identity has one supplier: the installer
refuses a contribution that another package or the release already
supplies. Registry location is not identity; moving a package between
registries never changes what it is.

## OCI artifact layout

A package travels as a standard OCI image, version 1:

- Artifact type: `application/vnd.tilecast.package.v1+json`.
- Config blob: `application/vnd.tilecast.package.config.v1+json`, carrying
  the manifest JSON.
- Content blobs: `application/vnd.tilecast.package.content.v1.tar+gzip`,
  carrying gzip tar archives of package files.

`VerifyLayout` in `internal/extensions/packages` opens an OCI image layout,
verifies every digest it follows, and returns the validated manifest with
the artifact digest the installer pins. A missing file, digest mismatch,
wrong media type, invalid manifest, or oversized blob fails closed with no
partial result. `WriteLayout` likewise propagates every filesystem write
failure instead of returning a usable artifact digest. Limits are 1 MiB
for layout documents and the manifest, 256 MiB per content blob.

At this stage, content blobs are integrity-checked opaque bytes after their
Tilecast tar+gzip media type is verified. Safe gzip/tar parsing and
extraction arrive with the external-runtime delivery stage; Stage 2 does
not extract or execute package content.

Remote registry transport resolves tags to digests, pulls the layout,
and feeds this same verifier, so local layouts, offline imports, and
registry pulls share one digest-pinned activation path. Retained package
bytes are re-verified before every reuse. The installer records the
resolved digest; a floating tag is never executed or persisted as the
active address. Retained bytes have no collector: content stays on disk
after removal, and the operator reclaims it by deleting the package
directory under `TILECAST_PACKAGES_ROOT`.

## Installer lifecycle

`internal/extensions/installer` records activations in `installed_packages`
and contribution ownership in `installed_package_contributions`
(migration `00116`). Activation is atomic and revalidates everything:

1. The manifest parses against the package contract.
2. The digest is a `sha256:` digest, never a tag.
3. The source kind, references, signer identity, and trust state are
   internally consistent. Verified packages require a signer identity;
   unsigned development packages cannot carry one.
4. Unsigned installs are refused unless the service allows development
   installs. That allowance is a constructor choice, never a request flag.
5. The Tilecast compatibility range holds for the running release.
6. Every derived contribution exactly matches one declared manifest
   `(type, path)`, sits inside the package namespace, and every declared
   contribution is accounted for.
7. Nothing else supplies the same contribution identity.

An update snapshots the replaced activation — digest, version, source,
registry, signer/trust provenance, manifest document, and contribution rows —
as the rollback target. Rollback restores the complete prior activation and
revalidates it like a fresh activation, so
a server upgrade that moved past its compatibility range refuses rather
than reviving an incompatible package. Rollback is single-level and clears
the snapshot. Removal deletes the row; contribution rows cascade.

Install, update, rollback, and removal each write one audit record with
resource type `package` and the version, digest, and trust state in the
metadata.

## External content contributions

Activation makes a package's declarative `widget` and `data_source`
contributions effective. The contributions service
(`internal/extensions/contributions`) reads the installed manifests after
every install, update, rollback, and removal, decodes the contributed
definitions through the same validators as built-in definitions, and swaps
the result into the services as one immutable snapshot. There is no partial
read: every request sees the definitions from one complete rebuild. A
package whose contribution fails to decode is skipped and logged; the
remaining packages still compose. Boot warns on skips and fails fast on a
rebuild that is not skip-only.

Each nested definition ID is qualified under its package ID, so a Data
Source provider reads `<package-id>.<nested-id>` (migration `00121` widens
the provider checks to accept dots). Qualification keeps provenance inside
the provider string: refresh states, error codes, and audit records name
the supplying package without a further lookup. External definitions use
the definition-keyed adapters only (`http_records`, `manual_object`,
`manual_records`); provider-keyed native adapters stay unavailable to
packages. External plugin behavior runs in the Wasm host below. It never
joins the content catalog.

## Player bundle delivery

A Widget contribution may ship an execution bundle at the fixed path
`runtime/index.js` inside the package. The pipeline records the bundle SHA-256
and size in the contribution snapshot at install time; a Widget presentation
that names a bundle without one compiles to no component and never reaches a
manifest.

Device-authenticated Players fetch the bundle from
`GET /api/v1/player/packages/{packageId}/widgets/{widgetId}`, with `HEAD`
for inspection. The server serves only the installed, verified bundle bytes
for an active credential; disabled screens and revoked credentials are
rejected before file access. The manifest `package` block carries the same
SHA-256 and size, so the Player verifies the download before activation.
Bundle bytes are content-addressed and pinned like media; removal of the
package invalidates the route.

Studio previews the same contribution through
`GET /api/v1/packages/{packageId}/widgets/{widgetId}/frame`, readable by
any signed-in account. The endpoint interpolates the verified bundle
into the generated sandbox frame template and serves the document with
a `sandbox` response policy, so the external code runs at an opaque
origin even when opened top-level. Unknown packages and missing
bundles share one `package_widget_unavailable` 404, mirroring the
player endpoint.

## External runtime

A version 2 package runs server behavior in a capability-based
WebAssembly host (`internal/extensions/wasm`, engine wazero). The host
imports one module, `tilecast`, with no WASI. The guest calls five host
functions: key read, key write, approved HTTPS fetch, log line, and
clock read. Nothing else is reachable. The call input window is 16 KiB. The
output window is 16 KiB. A job call times out after 30 seconds. A
Studio interface call times out after 5 seconds.

Install validation inspects the module bytes before anything is
retained or executed. The module must carry the Wasm magic and
version, import only the `tilecast` host functions with the exact ABI
signatures, declare bounded non-shared memory, define no start
function, and export the entries its capabilities need: `run_job`
for background jobs, `handle_ui_request` for Studio interface calls.
Anything else fails closed. The Studio entry page must hold 1 byte to
1 MiB.

Grants derive from the install review. Key storage scopes to the
package: 128-byte keys, 64 KiB values, 1 MiB total per package.
Approved fetch allows HTTPS only, to listed hosts only, with private
and link-local addresses refused. The host pins the resolved address
for the request. One response body caps at 1 MiB. One request times
out after 10 seconds. Log lines cap at a bounded length and carry the
package ID. The clock is wall time in milliseconds.

The scheduler runs declared jobs on their intervals
(`external_plugin_jobs`, migration `00122`). It claims due rows with
one atomic update under `SELECT ... FOR UPDATE SKIP LOCKED`, so two
server processes never run the same job twice. A claim holds a
five-minute lease. Execution is at-least-once: a crash mid-run
re-runs the job after the lease expires. A guest failure records
`last_status = error` with the message and reschedules on the same
interval. The first overdue pass runs at startup, then the scheduler
polls every minute.

The Studio interface serves the entry page from
`GET /api/v1/packages/{packageId}/studio/frame`, readable by any
signed-in account. The response carries an opaque-origin `sandbox`
policy with `allow-scripts` only: no network, no workers, no forms,
no subresource loads. The page must be self-contained. Unknown
packages and packages without the capability share one
`package_studio_unavailable` 404.

The frame holds no credentials. It posts calls to the Studio parent,
and the parent relays them with the dashboard session and CSRF token
over `POST /api/v1/packages/{packageId}/studio/bridge`. Owner and
Administrator only, like every package operation. The request carries
base64 input over the 16 KiB call window. A successful invocation
always answers 200 with the guest status code and base64 output.
Negative status codes are guest errors. Transport and host failures
become errors. The bridge frame protocol is `{source:
"tilecast-studio-ui", id, input}` from the frame and `{source, id,
status, output}` back. A failed relay answers `status: -1` with
`error: "bridge_failed"`.

`GET /api/v1/packages/{packageId}/jobs` reports the declared jobs
with the scheduler cursor: next run, last outcome, and consecutive
failures. Any signed-in account may read it.

Lifecycle keeps execution state aligned with activation. Install and
update reconcile the job rows. Update and rollback evict the replaced
digest from the compile cache and keep storage. Removal evicts the
digest, deletes the package keys, and deletes the job rows, so a
reinstall starts clean. Package bytes stay retained like any
activation.

## Sources

A package installs from exactly one source kind:

- `marketplace`: a listing in the official Tilecast catalog. See
  [Marketplace](marketplace.md). The listing pins identity, version, and
  digest; the pipeline resolves the pinned digest through the same
  registry and provenance path as a custom install.
- `custom`: a public GitHub repository the operator added. The binding
  persists in `custom_package_sources` (migration `00120`): one
  repository supplies one package, enforced in both directions, and the
  binding carries the last verified manifest and digest. Removing the
  installation keeps the binding for reinstall.

## GitHub resolution

`POST /api/v1/plugin-store/resolve-github` resolves a repository URL to
an install review and persists nothing:

1. The URL parses as a public GitHub repository. Anything else answers
   `invalid_repository`; private or missing repositories answer
   `repository_private` or `repository_not_found`.
2. The latest published release names the artifact: its tag must be a
   usable OCI tag (`release_tag_unusable` otherwise).
3. `tilecast.package.json` is read at that tag. A missing or invalid
   manifest answers `manifest_not_found` or `manifest_invalid`.
4. The registry resolves the manifest's OCI reference at the release tag
   to an immutable digest (`no_published_package` when the tag carries
   no artifact).
5. Sigstore provenance for the digest is verified against the
   repository's GitHub Actions identity. No verifying provenance answers
   `package_unsigned`. Unreachable trust infrastructure fails closed
   with `trust_unavailable`.

The review shows identity, version, compatibility with the running
release, contributions, the runtime module and capability requests of
a version 2 package, digest, release, and provenance. Installing
re-resolves fresh and cross-checks package ID, version, OCI reference,
and Tilecast range between the review and the published artifact; a
drift answers `package_mismatch` and installs nothing.

`POST /api/v1/plugin-store/{packageId}/resolve` gives a marketplace
listing the same review step before activation. The listing digest is
already pinned, so no tag resolves; the artifact still verifies
provenance, pulls by digest, and reads the published manifest. The
manifest — not the listing — is authoritative for capabilities, and
Studio shows the same review and requires confirmation before the
install activates. Unknown listings answer `plugin_not_found`.

Only GitHub repositories install in this release
(`repository_not_supported` otherwise).

## Update, rollback, and removal

`POST /api/v1/packages/{packageId}/update-check` resolves the latest
artifact without activating anything: a custom package re-resolves its
repository, and a marketplace package refreshes the catalog first. The
check answers the installed package plus the latest review when an
update is available. When the check can read the artifact, each review
contribution also carries its package-qualified `id`, so Studio shows an
ID change even when the contribution path stays the same. A review that
could not read the artifact omits `id`, and Studio then compares by type
and path only.

`POST /api/v1/packages/{packageId}/update` takes the digest the check
approved, re-resolves fresh, and activates only when the digest still
matches. A stale digest answers `update_check_expired`: check again and
confirm the new digest. Rollback restores the previous activation
(`no_rollback` when there is none). Removal deletes the installation
and its contribution rows; the custom binding, when any, survives.

Removal, update, and rollback are refused with `package_in_use` (HTTP 409) while content still uses a contribution the operation would drop.
The error names the package, the action, and each blocking resource with
its count, so the operator deletes the listed Widgets or Data Sources
first. Removal is therefore never a way to delete a site's content:
delete the content, then remove the package. Update answers the same
error when the new version drops a contribution that content still
uses; rollback answers it when the restored version would.

Reads (`GET /api/v1/packages`, `GET /api/v1/packages/{packageId}`)
answer any signed-in role. Resolution, install, update, rollback, and
removal require Owner or Administrator with a CSRF token. The store
serves custom entries with source kind `custom` and the repository URL
as provenance; they carry no curated listing metadata and no update
flag, since freshness needs a live re-resolution.

## Configuration

- `TILECAST_PACKAGES_ROOT` (default `/data/packages`): retained package
  bytes. Back this directory up with the database.
- `TILECAST_ALLOW_UNSIGNED_EXTENSIONS` (default `false`): development
  builds only. Stable releases refuse unsigned packages even when this
  is set.
- `TILECAST_GITHUB_TOKEN` (optional): raises GitHub API rate limits for
  resolution. Never required for public repositories.

## Backup and restore

The database snapshot carries the package tables like any other table, so
a restore brings activations back exactly. The backup manifest also pins a
per-package summary — exact IDs, versions, digests, sources, and signer
identities — so an operator names what a backup holds without restoring
it. The summary is additive: older archives decode without it and remain
valid.

## Boundaries

This stage builds the package format, validation, installed state, OCI
layout verification, registry fetching, Sigstore provenance verification,
activation with rollback, effective external content contributions,
removal/update/rollback blockers, backup metadata, package HTTP
endpoints, custom repository bindings, Studio package management,
player bundle delivery, the Widget sandbox frame, and the external
Wasm runtime with background jobs and the Studio interface. It does not
add private registry authentication or a package-bytes collector.
