# Marketplace

The Tilecast marketplace is a curated directory of extension packages.
`marketplace/catalog.json` in the Tilecast repository is the source of
truth. Marketplace submissions are ordinary reviewed pull requests that
modify that file.

Tilecast Server fetches the official catalog, validates it, and caches
it. Tilecast Studio shows the cached listings in Explore. Studio never
contacts GitHub. The marketplace never hosts package bytes. Package
bytes stay in OCI registries. See [Extension packages](packages.md) for
the package format.

## Official source

The server knows the official catalog address itself:

`https://raw.githubusercontent.com/gbyo/tilecast/main/marketplace/catalog.json`

The marketplace needs no operator configuration. The server always
serves the official catalog. The retired
`TILECAST_MARKETPLACE_CATALOG_URL` and
`TILECAST_MARKETPLACE_PUBLIC_KEY` variables have no effect.

## Catalog document

The catalog is a JSON document with a format version and listings. Each
listing carries display metadata, the publisher identity, the Tilecast
compatibility range, the OCI distribution reference, the pinned artifact
digest, presentation metadata, and the source, documentation, and issue
links.

The Server rejects a document in these cases:

- The format version is not 1.
- A package ID repeats.
- Listings are not sorted by package ID.
- A listing carries an unknown field.
- A listing field is invalid. Package IDs must be qualified and outside
  the reserved `tilecast` namespace. Versions must be SemVer. The
  package ID must start with the publisher namespace. The OCI reference
  must be tagless and digestless. The digest must be a pinned `sha256`
  address. The repository link must be a `github.com` https URL with an
  owner and repository path. The documentation and issue links must be
  empty or use https with a host and path. Categories must be lowercase
  slugs of at most 5 entries with no repeats.

A listing means the Tilecast project accepted the repository into the
official Marketplace. A listing is not a security audit of the package.
Install integrity stays with the package pipeline: digest pinning,
provenance verification, manifest validation, and runtime boundaries.

## Fetching and caching

The Server owns marketplace fetching. Studio never contacts the catalog
or a registry for package lifecycle operations.

The Server refreshes the cache in two ways:

- Automatic refresh: the maintenance loop checks the cache each minute
  and fetches when the cache is missing or older than one hour. A fresh
  cache causes no request. The server also refreshes in the background
  at startup.
- Manual refresh: Owner or Administrator calls
  `POST /api/v1/plugin-store/marketplace/refresh` with a CSRF token.
  The call fetches now and answers the cache status.

A failed fetch records its error in the cache row and keeps serving the
last valid document with its age and error. The automatic refresh
waits 15 minutes after a failure before it tries again. A manual
refresh always attempts and ignores that wait.

The fetch sends `If-None-Match` when the cache holds an ETag. A `304`
answer keeps the document and clears the error. The fetch follows at
most three redirects, only to acceptable URLs on the same origin. The
fetch caps the catalog at 5 MiB. A malformed catalog never replaces a
previously valid cached catalog.

## Fresh installation fallback

The server binary ships a bundled snapshot of the repository catalog.
Before the first successful refresh, the store serves that snapshot, so
a fresh installation lists the marketplace even when GitHub is
unreachable at first boot. A later successful refresh replaces the
snapshot. The snapshot is a build copy of `marketplace/catalog.json`,
not a second source of truth. Repository checks fail when the copy
drifts from its source.

## Store merge

The plugin store joins cached listings with the release-owned entries.
Each marketplace entry carries the listing, the compatibility result
against the running release, the installed state from
`installed_packages`, and the update state. The store answers a
marketplace status block with the last fetch time, the stale flag, and
the last error.

A marketplace failure never fails the store. The release-owned entries
still serve, with the failure recorded on the marketplace status.

Marketplace listings are read-only in this release. Explore shows them,
their detail page describes them, and installation arrives with custom
repository installs.

## Offline behavior

An installed package keeps working when the marketplace is
unreachable. The store shows the last valid listings with the error
and the age. Playback never depends on marketplace availability.

## Audit

A manual refresh writes an audit event. A successful refresh uses
`marketplace.refreshed` with the listing count. A failed refresh uses
`marketplace.refresh_failed`. The audit metadata carries no secrets.
