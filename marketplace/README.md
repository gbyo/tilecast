# Tilecast Marketplace catalog

`catalog.json` is the canonical source of truth for the official Tilecast
Marketplace. It is a curated list of GitHub repositories with the metadata
Tilecast needs to render the directory, check compatibility, and resolve
the install.

Marketplace submissions are ordinary GitHub pull requests that modify this
file. The pull request review accepts the listing into the official
Marketplace. CI validates every listing before merge.

One file powers both surfaces:

- Tilecast Studio reads the catalog through Tilecast Server.
- The public Marketplace page reads this same file.

## Catalog shape

```json
{
  "formatVersion": 1,
  "listings": [
    {
      "packageId": "acme.athletics",
      "name": "Athletics",
      "description": "Scoreboards, schedules, standings and game information.",
      "publisher": { "id": "acme", "name": "Acme Athletics" },
      "repository": "https://github.com/acme/tilecast-athletics",
      "documentation": "https://example.com/docs",
      "issues": "https://github.com/acme/tilecast-athletics/issues",
      "version": "2.4.1",
      "tilecastRange": ">=1.2.0 <2.0.0",
      "oci": "ghcr.io/acme/tilecast-athletics",
      "digest": "sha256:...",
      "license": "MIT",
      "categories": ["sports", "data"],
      "featured": false
    }
  ]
}
```

## Required fields

Each listing must carry these fields:

- `packageId`: qualified package identity outside the reserved `tilecast`
  namespace. The ID must start with the publisher namespace.
- `name`: display name of 1 to 80 characters.
- `description`: summary of 1 to 500 characters.
- `publisher.id`: one namespace segment. It must match the first segment
  of `packageId`.
- `publisher.name`: display name of 1 to 80 characters.
- `repository`: https address of the source GitHub repository, with
  exactly an owner and name. A trailing slash or `.git` suffix is
  allowed. Deeper paths such as issue or tree pages are rejected.
- `version`: SemVer release of the listed package.
- `tilecastRange`: supported Tilecast releases, such as
  `>=1.2.0 <2.0.0`.
- `oci`: tagless and digestless registry reference of the package
  artifact.
- `digest`: immutable `sha256` digest of the exact artifact that
  installs.
- `license`: license name of 1 to 32 characters.

## Optional fields

Each listing may carry these fields:

- `documentation`: https link to package documentation.
- `issues`: https link to the issue tracker.
- `categories`: at most 5 lowercase slugs of letters, digits, and
  hyphens. Each category must hold 1 to 32 characters. Categories must
  not repeat.
- `featured`: true marks a listing for the directory showcase. Omit the
  field or set false for a normal listing.

## Listing rules

Follow these rules when you add or update a listing:

- Keep listings sorted by `packageId`. CI rejects unsorted catalogs.
- Use each `packageId` once. CI rejects duplicates.
- Point `repository` at a public `github.com` repository with exactly
  an owner and name. The server rejects any other host and any deeper
  path. The catalog and the installer share one parser, so a listing
  the catalog accepts always resolves at install time.
- Point `oci` and `digest` at the exact release artifact. The digest
  must be immutable. The install pipeline verifies provenance for that
  digest before it activates any bytes.
- State the supported releases in `tilecastRange`. Tilecast Server
  computes compatibility from this range.
- Add no unknown fields. The server parses the catalog strictly and
  rejects unknown fields.

## Contributor flow

1. Publish the Tilecast plugin package.
2. Create a release package artifact.
3. Note the immutable artifact digest.
4. Add a listing to `marketplace/catalog.json`.
5. Run the marketplace validation tests.
6. Open a pull request.

Run this command from the repository root to validate the catalog:

```sh
cd apps/server && go test ./internal/extensions/catalog/
```

The test validates the file with the same validator Tilecast Server
uses for fetched catalogs. A listing that fails here cannot merge.

## Review expectations

A maintainer reviews each submission for these properties:

- The publisher namespace matches the package author.
- The repository holds the published package source.
- The digest addresses the published artifact.
- The description, links, and license are accurate.
- The Tilecast range matches the tested releases.

A listing means the Tilecast project accepted the repository into the
official Marketplace. A listing is not a security audit of the package.
Install integrity stays with the package pipeline: digest pinning,
provenance verification, manifest validation, and runtime boundaries.
Package bytes never live in this file.

See [Marketplace](../docs/marketplace.md) for the server fetch, cache,
and status contract.
