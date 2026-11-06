# Layout schema

This package owns the future renderer-neutral, versioned layout contract. Layouts use generic placements rather than a bespoke element type for every signage feature:

- `app`: stable reference to a reusable configured App/Source Content item
- `asset`: stable reference to an uploaded image or video
- `playlistZone`: reference to an existing playlist and zone playback settings
- `primitive`: static text, shape, line, decorative image, or group

Every placement carries bounded geometry, layer, opacity, visibility, and only type-approved display overrides. Shared App configuration and fetched structured data are not copied into layout revisions. Data bindings reference a Source plus a validated field path; they are not executable templates, HTML, CSS, JavaScript, or arbitrary expressions.

See `docs/widgets-and-layouts.md` for the ownership contract that layout schema versions must preserve.

`schema-v2.json` is the current contract. A text primitive may set `fontId` to an organization font library family; `fontFamily` stays the bundled fallback (see `docs/fonts.md`). Placements use `type: "widget"` with a `widgetId`; text primitives may bind to one field of a declared Data Source through `binding.dataSourceId`. A Data Source is never itself a placement. Server and Player validators enforce the same hard limits in code before accepting or activating a document.
