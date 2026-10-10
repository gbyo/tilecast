# Adding a Tilecast App

Tilecast integrations remain release-owned and declarative. Start with the narrowest path below; do not add a provider switch to Studio or either Player when the catalog and existing adapters can express the feature.

## Feed App

Use an App recipe when one user-facing setup should provision a managed RSS or Atom Data Source and a native Widget. Add a definition with `kind: "app"`, a native presentation (or `presentationBase`), and a `recipe.dataSource` containing a known Data Source provider and a release-owned configuration template. Template substitution is limited to an object containing only `$config`; startup validation rejects unknown fields and dependencies.

Provider feed choices should be fixed `select` options owned by the release. Use a URL control only for explicitly generic Apps such as Custom RSS. Never scrape a provider, add another XML parser, or let a provider choice substitute a scheme or host. Reuse `news-feed` or another native declarative presentation and include tests for feed normalization and the complete managed-source lifecycle.

## Web Integration App

Use a Web Integration for a provider that documents a public/published embed mechanism. Declare the URL field, fixed hosts or an intentional any-HTTPS-host policy, a closed compiled transform, timeout, fallback, lifecycle, warm duration, and optional reload field. Current transforms are pass-through, Google Sheets, Google Slides, and Canva embed normalization. Add a compiled transform in Go only when a provider's public link must be converted safely; catalog JSON never carries regex or code.

Test accepted and rejected hosts, normalization, reload serialization, and Player behavior. Setup copy must say when publishing makes data public and must not imply Tilecast bypasses provider authentication or embedding policy.

Resolve provider short links during authoring, then store the canonical URL in the existing configuration field.
Keep manifest compilation independent of provider availability.
Reuse the Source transport for DNS-pinned connections with a fixed provider URL policy.
Do not inherit private-network permission for a public short-link provider.
Studio iframe load events do not prove that cross-origin content loaded successfully.
See the [Canva contract and manual verification](widgets-and-layouts.md#canva-link-and-preview-contract) for this implementation.

## Connected App

Use this path for private Google, Microsoft, Meta, or similar data. It requires the separate Connections domain: server-side protected credentials, explicit scopes, status/reconnect/revoke behavior, and a connection ID in App configuration. Tokens and secrets must never enter manifests or Players. Until that domain and its backup policy are implemented, keep the catalog entry disabled with a concise reason.

## Native Widget

Use a native Widget to render existing typed data. Define its form and closed presentation tree in the catalog and declare every capability its nodes use. Keep data acquisition in a Data Source. A new definition using existing nodes should require no React registry, Kotlin provider enum, Linux provider enum, or database provider enum.

## Review checklist

- The catalog is the only gallery and validation registry.
- Data Sources acquire and cache; Widgets present; Layouts arrange.
- Provider URLs are HTTPS and pinned or intentionally self-hosted.
- No arbitrary scripts, HTML, expressions, player-side fetching, or provider code is introduced.
- Native data remains usable offline; web content has an explicit fallback.
- Managed resources are covered by create, edit, duplicate, dependency, deletion, and backup behavior.
- Catalog, adapter, manifest, Studio, and both Player tests cover the new behavior.
