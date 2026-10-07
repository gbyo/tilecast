# Extension packages

An extension package is a distribution container, not a fourth extension
API. It carries distribution, version, provenance, and contribution
metadata for Widgets, declarative Data Sources, and (once the external
runtime exists) plugin behavior. The contribution contracts themselves
(`tilecast.widget.json`, `tilecast.datasource.json`,
`tilecast.plugin.json`) do not change. See
[Content extension model](content-extension-model.md) for the architecture.

## Manifest

`tilecast.package.json` version 1 is the manifest. Required fields:

- `apiVersion`: `1`. Only 1 exists.
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
fields are rejected: a manifest cannot grant itself capabilities, declare
a source, or name code to download. Contribution paths point inside the
package and cannot escape it. Each contribution root is unique across the
package, even when the contribution types differ.

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
release, contributions, digest, release, and provenance. Installing
re-resolves fresh and cross-checks package ID, version, OCI reference,
and Tilecast range between the review and the published artifact; a
drift answers `package_mismatch` and installs nothing.

Only GitHub repositories install in this release
(`repository_not_supported` otherwise).

## Update, rollback, and removal

`POST /api/v1/packages/{packageId}/update-check` resolves the latest
artifact without activating anything: a custom package re-resolves its
repository, and a marketplace package refreshes the catalog first. The
check answers the installed package plus the latest review when an
update is available.

`POST /api/v1/packages/{packageId}/update` takes the digest the check
approved, re-resolves fresh, and activates only when the digest still
matches. A stale digest answers `update_check_expired`: check again and
confirm the new digest. Rollback restores the previous activation
(`no_rollback` when there is none). Removal deletes the installation
and its contribution rows; the custom binding, when any, survives.

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
activation with rollback, backup metadata, package HTTP endpoints, custom
repository bindings, and Studio package management. It does not add
private registry authentication, content extraction to players, removal
blockers against installed content, or a package-bytes collector. Those
arrive with the sandbox and runtime stages behind the contracts defined
here.
