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
package and cannot escape it.

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
partial result. Limits are 1 MiB for layout documents and the manifest,
256 MiB per content blob.

Remote registry transport arrives with the marketplace and
custom-repository stages and feeds this same verifier, so local layouts,
offline imports, and registry pulls share one digest-pinned activation
path. The installer records the resolved digest; a floating tag is never
executed or persisted as the active address.

## Installer lifecycle

`internal/extensions/installer` records activations in `installed_packages`
and contribution ownership in `installed_package_contributions`
(migration `00116`). Activation is atomic and revalidates everything:

1. The manifest parses against the package contract.
2. The digest is a `sha256:` digest, never a tag.
3. The source kind, references, and trust state are well formed.
4. Unsigned installs are refused unless the service allows development
   installs. That allowance is a constructor choice, never a request flag.
5. The Tilecast compatibility range holds for the running release.
6. Every contribution sits inside the package namespace.
7. Nothing else supplies the same contribution identity.

An update snapshots the replaced activation — digest, version, manifest
document, and contribution rows — as the rollback target. Rollback
restores from that snapshot and revalidates it like a fresh activation, so
a server upgrade that moved past its compatibility range refuses rather
than reviving an incompatible package. Rollback is single-level and clears
the snapshot. Removal deletes the row; contribution rows cascade.

Install, update, rollback, and removal each write one audit record with
resource type `package` and the version, digest, and trust state in the
metadata.

## Backup and restore

The database snapshot carries the package tables like any other table, so
a restore brings activations back exactly. The backup manifest also pins a
per-package summary — exact IDs, versions, digests, sources, and signer
identities — so an operator names what a backup holds without restoring
it. The summary is additive: older archives decode without it and remain
valid.

## Boundaries

This stage builds the package format, validation, installed state, OCI
layout verification, activation with rollback, and backup metadata. It
does not add registry fetching, signature verification, package HTTP
endpoints, Studio package UI beyond the store shell, content extraction to
players, or removal blockers against installed content. Those arrive with
the marketplace, custom-repository, sandbox, and runtime stages behind the
contracts defined here.
