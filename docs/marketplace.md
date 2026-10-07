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
  address. The repository link must be a `github.com` https URL with
  exactly an owner and name; the catalog and the installer share one
  parser. The documentation and issue links must be
  empty or use https with a host and path. Categories must be lowercase
  slugs of at most 5 entries with no repeats. `longDescription`, when
  present, must be plain text of at most 2000 characters. It may hold
  line breaks and no other control characters. Artwork must follow the
  rules in [Artwork](#artwork).

`longDescription` is optional presentation text for the detail page.
Studio shows it as plain text, never as markup. When it is absent, the
page shows `description`. It has no effect on package identity, the
digest, provenance, capabilities, or installation.

A listing means the Tilecast project accepted the repository into the
official Marketplace. A listing is not a security audit of the package.
Install integrity stays with the package pipeline: digest pinning,
provenance verification, manifest validation, and runtime boundaries.

## Artwork

A listing can carry an icon and screenshots. Artwork is presentation
metadata only. Artwork does not change package identity, artifact trust,
digest verification, provenance, capabilities, or installation. A
listing without artwork is valid, and a listing with artwork that fails
to load installs the same way.

```json
{
  "icon": "https://raw.githubusercontent.com/acme/tilecast-athletics/main/icon.png",
  "screenshots": [
    {
      "src": "https://raw.githubusercontent.com/acme/tilecast-athletics/main/scoreboard.png",
      "alt": "A scoreboard on a lobby display."
    }
  ]
}
```

The catalog validation rules for artwork are:

- `icon` is optional. It is one image address.
- `screenshots` is optional. It holds at most 5 entries. Each entry has
  exactly `src` and `alt`. An unknown field in an entry rejects the
  catalog.
- Each address must use `https`, must be at most 512 characters, and
  must have a host name and a path. The address must not hold
  credentials, a fragment, whitespace, or control characters.
- The host must be a name, not an IP address. A single-label host and a
  host that ends in `.local`, `.localhost`, `.internal`, `.lan`,
  `.home`, `.corp`, or `.intranet` are rejected. The address must use
  the default port.
- `alt` is required for each screenshot. It must hold 1 to 200
  characters of text without control characters.

### Artwork serving

Studio never loads an image from the address the catalog names. The
server fetches each image, checks it, and serves it from its own path.
The store response gives Studio only these server paths, in an
`artwork` block on the marketplace entry:

- `GET /api/v1/plugin-store/{packageId}/artwork/icon`
- `GET /api/v1/plugin-store/{packageId}/artwork/screenshots/{index}`

The paths need a signed-in account with read scope. They are not a
general image proxy. A request names a package and an artwork slot, and
never an address. The server reads the address from the validated
catalog listing. A request for an unknown package, a slot the listing
does not declare, or an index that is out of range answers `404
artwork_unavailable`.

Each fetch follows these rules:

- The address must pass the catalog validation rules again.
- The fetch uses HTTPS only. It follows at most 3 redirects, and each
  redirect target must pass the same rules.
- The fetch carries no cookies, no `Authorization` header, and no
  Tilecast credentials. The client keeps no cookies and uses no proxy
  from the environment.
- The server refuses to connect to a non-public address. The check runs
  when the socket connects, on the address actually used, so a host
  name that resolves to a private address, or that changes its answer
  after validation, is refused. Loopback, private, link-local,
  carrier-grade NAT, multicast, reserved, documentation, 6to4, and NAT64
  addresses are refused.
- The fetch times out after 10 seconds.
- The response must be HTTP 200 and at most 1 MiB.
- The server reads the image bytes and serves only PNG, JPEG, GIF, and
  WebP. The server ignores the origin `Content-Type`. The server never
  serves SVG or HTML.

The server serves the image with the detected content type,
`X-Content-Type-Options: nosniff`, and a restrictive
`Content-Security-Policy`. The response carries an `ETag` and
`Cache-Control: private, max-age=86400`. The store adds a `v` query
value that changes with the catalog address, so a changed image
replaces the cached image in the browser.

### Artwork cache

The server keeps verified images in process memory. The cache holds at
most 32 MiB and at most 256 entries, and it removes the least recently
used entry first. A fetched image serves for 24 hours. A failed fetch is
remembered for 5 minutes, so an unreachable host is not requested again
for each page view. Concurrent requests for one image share one fetch.
The cache is not persisted, adds nothing to a backup, and rebuilds on
demand after a restart.

A missing, slow, or refused image never fails the store. The store
still lists the entry, and Studio shows the generic plugin icon. A
screenshot that does not load keeps its place in the carousel on the
detail page with a placeholder. A listing with no screenshots has no
screenshot section on that page.
Custom repositories have no artwork. Their entries use the generic icon.

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

The entry also carries an `artwork` block with the server paths for the
icon and screenshots, when the listing declares them. See
[Artwork](#artwork).

A marketplace failure never fails the store. The release-owned entries
still serve, with the failure recorded on the marketplace status.

Owner or Administrator reviews a listing from its detail page. Studio
shows the review in a dialog, or in a drawer on a narrow viewport. The
review calls
`POST /plugin-store/{packageId}/resolve`, then installs with
`POST /plugin-store/{packageId}/install` and an empty body. The listing
pins identity, version, and digest; the pipeline verifies provenance
and reads the published manifest for review, and the install
re-resolves and activates through the same path as a custom install.
See [Extension packages](packages.md).

## Offline behavior

An installed package keeps working when the marketplace is
unreachable. The store shows the last valid listings with the error
and the age. Playback never depends on marketplace availability.

Operator note: installing a listing adds its Widgets and Data Sources
to the Studio catalog under the package namespace, and removing the
package is refused while any of them remain in use. Plan content
cleanup before removal: delete the package-built Widgets and Data
Sources first, then remove the package.

## Audit

A manual refresh writes an audit event. A successful refresh uses
`marketplace.refreshed` with the listing count. A failed refresh uses
`marketplace.refresh_failed`. The audit metadata carries no secrets.
