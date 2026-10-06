# Marketplace

The Tilecast marketplace is a remote listing of curated extension
packages. Tilecast Server fetches the listing, verifies its signature,
and caches it. Tilecast Studio shows the cached listings in Explore.
The marketplace never hosts package bytes. Package bytes stay in OCI
registries. See [Extension packages](packages.md) for the package
format.

## Configuration

The operator configures two values together:

- `TILECAST_MARKETPLACE_CATALOG_URL`
- `TILECAST_MARKETPLACE_PUBLIC_KEY`

The Server refuses to start when only one value is set. An empty pair
disables the marketplace. No request leaves the Server while the
marketplace is disabled.

The catalog URL must use https. The Server accepts plain http only on
loopback addresses, for development and tests. The URL must not carry
credentials, because fetch errors name the URL. The public key must be a
base64 Ed25519 public key of 32 bytes.

## Catalog document

The catalog is a JSON document with a format version, an issue time, an
expiry time, and listings. Each listing carries display metadata, the
publisher identity, the Tilecast compatibility range, the OCI
distribution reference, the pinned artifact digest, and the source,
documentation, and issue links.

The Server rejects a document in these cases:

- The format version is not 1.
- The issue time is more than five minutes in the future.
- The document is expired.
- A package ID repeats.
- A listing field is invalid. Package IDs must be qualified and outside
  the reserved `tilecast` namespace. Versions must be SemVer. The
  package ID must start with the publisher namespace. The OCI reference
  must be tagless and digestless. The digest must be a pinned `sha256`
  address. The repository link must be an https URL with a host and a
  path. The documentation and issue links must be empty or use the same
  shape.

## Signature

The marketplace signs the exact catalog bytes with Ed25519. The signed
envelope carries the payload bytes and detached signatures. The Server
verifies the envelope against the pinned key before it parses the
document. Verification succeeds when a signature under the pinned key ID
covers the exact payload bytes. Unknown envelope fields fail the check.

The Server stores the exact signed bytes in the cache. Serving the
cache never reinterprets the bytes that the key covered.

Signature verification covers the catalog only. A marketplace listing
is not a security audit of the package.

## Fetching and caching

The Server owns marketplace fetching. Studio never contacts the catalog
or a registry for package lifecycle operations.

The Server refreshes the cache in two ways:

- Automatic refresh: the maintenance loop checks the cache each minute
  and fetches when the cache is missing or expired. A fresh cache
  causes no request.
- Manual refresh: Owner or Administrator calls
  `POST /api/v1/plugin-store/marketplace/refresh` with a CSRF token.
  The call fetches now and answers the cache status.

A failed fetch records its error in the cache row and keeps serving the
last verified document with its age and error. The automatic refresh
waits 15 minutes after a failure before it tries again. A manual
refresh always attempts and ignores that wait.

The fetch sends `If-None-Match` when the cache holds an ETag and the cached document is still fresh. Once the cached document is expired, refresh sends an unconditional request. A `304`
answer keeps the document and clears the error. The fetch follows at
most three redirects, and only to acceptable URLs. The fetch caps the
envelope at 5 MiB.

## Store merge

The plugin store joins cached listings with the release-owned entries.
Each marketplace entry carries the listing, the compatibility result
against the running release, the installed state from
`installed_packages`, and the update state. The store answers a
marketplace status block with the configured flag, the last fetch time,
the stale flag, and the last error.

A marketplace failure never fails the store. The release-owned entries
still serve, with the failure recorded on the marketplace status.

Marketplace listings are read-only in this release. Explore shows them,
their detail page describes them, and installation arrives with custom
repository installs.

## Offline behavior

An installed package keeps working when the marketplace is
unreachable. The store shows the last verified listings with the error
and the age. Playback never depends on marketplace availability.

## Audit

A manual refresh writes an audit event. A successful refresh uses
`marketplace.refreshed` with the listing count. A failed refresh uses
`marketplace.refresh_failed`. The audit metadata carries no secrets.
