# Tilecast Marketplace catalog

`catalog.json` is the canonical, reviewable source for the official Tilecast
Marketplace. Marketplace listing changes are ordinary GitHub pull requests so
the catalog has code review, history, and a permanent diff.

This source document is deliberately **not** the document Tilecast Server
trusts over the network. It contains stable listing metadata only. Publication
automation validates the source, adds `issuedAt` and `expiresAt`, and signs
the resulting runtime document. Servers fetch and verify that signed envelope.

The public docs marketplace is built from this same `catalog.json`; it is a
human-readable view, not a second source of truth.

Package bytes do not live here. A listing points at an immutable OCI artifact
digest and the package's source repository.

## Source shape

```json
{
  "formatVersion": 1,
  "listings": [
    {
      "packageId": "acme.athletics",
      "version": "2.4.1",
      "name": "Athletics",
      "description": "Scoreboards, schedules and game information.",
      "publisher": { "id": "acme", "name": "Acme Athletics" },
      "license": "MIT",
      "tilecastRange": ">=1.2.0 <2.0.0",
      "oci": "ghcr.io/acme/tilecast-athletics",
      "digest": "sha256:...",
      "repository": "https://github.com/acme/tilecast-athletics",
      "documentation": "https://example.com/docs",
      "issues": "https://github.com/acme/tilecast-athletics/issues"
    }
  ]
}
```

The runtime catalog adds only publication metadata and signatures; it does not
invent or rewrite listing metadata.

Keep listings sorted by `packageId`. Server CI reads this source file with the
same listing validator used for signed runtime catalogs, so an invalid or
duplicate listing cannot merge silently.
