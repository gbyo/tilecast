# Organization font library

The organization font library holds the typefaces that Layout text and plugins
can use. An administrator adds a family from the Google Fonts catalog or uploads
font files. The Tilecast Server stores each font file. Tilecast Player
downloads a font file with the published content that uses it.

The font library covers Layout text and Plugin API v2 plugins (Countdown Bar
first). Widgets and organization default fonts are later work.

## Ownership

- The `internal/fonts` package owns families, faces, catalog access, upload
  validation, and deletion.
- The `internal/layouts` package validates a text primitive `fontId` and
  records a `font` dependency.
- The `internal/playlists` package puts the font faces of each Layout and of
  each Plugin API v2 state entry into the Player manifest.
- The `internal/plugins` package implements `Host.Fonts`, which records the
  families that plugin instances use.
- The Player Runtime registers each face and draws Layout text with it.
- Each Player host serves the face bytes through its `tcmedia:` handler.

## Data model

Migration `00132_font_library.sql` adds these tables:

| Table             | Contents                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `font_families`   | One row for each family name. The row records the source (`google` or `upload`), the catalog ID and version, the category, the license, and the subsets.            |
| `font_faces`      | One row for each stored file. The row records the style (`normal` or `italic`), the weight range, the subset, and the CSS `unicode-range`. It references one asset. |
| `font_references` | One row for each family that a plugin instance uses (migration `00133`). The row records the plugin ID, the instance ID, and the instance name.                     |

Each face file is an asset with `type='font'` and `system_managed=TRUE`. The
asset has one `original` variant with `player_compatible=TRUE`. This design
gives these properties:

- The file uses verified media storage and the media backup.
- Players download the file through `GET /api/v1/player/assets/{assetId}/variants/{variantId}`.
- The Media library, its pickers, and playlists do not show the file, because
  each of these queries requires `system_managed=FALSE`.
- The generic Media API returns `404` for a font asset. Only the font library
  can read or remove a font asset.

The family name is display metadata only. A family name never becomes a CSS
identifier, a file name, or a path. Content refers to a family by its
generated ID.

A family name is unique in the organization, without regard to case, among
families that are not deleted.

## Google Fonts catalog

The Server reads the catalog from the Fontsource API
(`https://api.fontsource.org`). Fontsource mirrors every Google Fonts family.
The API needs no key. Font files come from the fixed prefix
`https://cdn.jsdelivr.net/fontsource/fonts/` with a pinned package version.

The Server contacts the catalog only when an administrator searches, opens a
family, or adds a family. Players and Tilecast Studio never contact the
catalog. After a family is stored, no feature depends on the catalog.

`TILECAST_FONT_CATALOG_ENABLED` controls catalog access. The default is
`true`. When the value is `false`, the Server makes no catalog request, and the
catalog endpoints return `font_catalog_disabled`. Uploads continue to operate.

Catalog rules:

- The listing contains only `type: "google"` families with a valid ID, a
  family name of at most 100 characters, and a known category.
- The Server keeps the listing for 24 hours, and a family detail for one hour.
- A family ID must match `^[a-z0-9][a-z0-9-]{0,99}$` before the Server sends a
  request.
- A download must start with the fixed CDN prefix and must not contain `..`, a
  query, a fragment, or a backslash.
- A downloaded file must start with the WOFF2 signature `wOF2`.
- A catalog `unicode-range` must match the CSS `unicode-range` grammar.

### Import selection

An import names a family, a list of subsets, a list of styles, and, for a
static family, a list of weights.

- An empty subset list selects the default subset of the family.
- An empty style list selects `normal`.
- If the family has a variable `wght` axis, the Server downloads one variable
  file for each subset and style. That file covers the full weight range. The
  Server ignores the weight list.
- If the family has no variable weight axis, the Server downloads one static
  file for each subset, style, and weight. An empty weight list selects the
  weight nearest to 400.
- A subset that Fontsource divides into numbered slices (for example
  Japanese, Korean, and Chinese) maps to all of its numbered slices. Each
  slice keeps its own `unicode-range`.

Limits:

| Limit                   | Value  |
| ----------------------- | ------ |
| Files in one import     | 400    |
| One downloaded file     | 8 MiB  |
| Total of one import     | 64 MiB |
| Import download timeout | 5 min  |

An import is all or nothing. If one download fails, the Server removes every
file that the import wrote, and it stores no rows.

## Uploads

An upload is one TrueType (`.ttf`) or OpenType CFF (`.otf`) file. The limit is
15 MiB. The request must set `rightsConfirmed=true`. That value records that
the organization may show the font on its displays.

The Server refuses these files:

- Font collections (`ttcf`).
- WOFF and WOFF2 files. The Server does not decompress web font formats.
- A file that `golang.org/x/image/font/sfnt` cannot parse.
- A file with a table that is outside the file bounds.

The Server reads the face properties from the file tables:

- Family: name ID 16 (typographic family), then name ID 1. If both are
  empty, the Server uses the uploaded file name without its extension.
- Weight: `OS/2.usWeightClass`, or the `fvar` `wght` axis range for a
  variable font.
- Style: `OS/2.fsSelection` bit 0, or `head.macStyle` bit 1.
- Embedding restriction: `OS/2.fsType` value 2. The upload succeeds, and the
  response sets `embeddingRestricted` so that Studio shows a warning.

A face joins an uploaded family that has the same name. A face cannot join a
family from the catalog. A face with the same SHA-256 as a face in the family
is refused.

## Deletion

A person with `settings.manage` can remove a family when no Layout and no
plugin instance uses it. A Layout uses a family when its current draft or its
published revision has a `font` dependency on the family. A plugin instance
uses a family when it has a `font_references` row. The Server returns
`font_in_use` with the Layout names and the plugin instance names.

The deletion locks the family row `FOR UPDATE`. A Layout save and
`Host.Fonts.UseInTx` read the family row `FOR SHARE` before they record the
dependency. This order prevents a save and a deletion from passing each other.

The deletion marks the family deleted and marks each face asset `deleting`.
The media worker removes the files with the ordinary `delete_asset_files` job.

## Layout text

A text primitive can set `fontId` to a family ID. The text primitive keeps
`fontFamily` as the bundled fallback. Validation refuses `fontId` on a
primitive that is not text. Draft save and publication refuse an unknown or
deleted family.

The Player manifest adds an optional `fonts` array to each Layout entry. The
array is additive: a Player that predates the font library ignores the key and
draws the text with `fontFamily`. The manifest schema version does not change.

```json
{
  "fonts": [
    {
      "id": "5c0a2f8e-3c1b-4d2a-9e7f-0a1b2c3d4e5f",
      "family": "Inter",
      "faces": [
        {
          "assetId": "1f8f2d8e-1b1a-4c55-9a0d-3d2f6c7b8a90",
          "variantId": "7b6a5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d",
          "style": "normal",
          "weightMin": 100,
          "weightMax": 900,
          "unicodeRange": "U+0000-00FF"
        }
      ]
    }
  ]
}
```

Each face file is also in the manifest `assets` array. Player Core gives an
asset that no playlist item references a verified download policy, so each
face is a verified offline resource.

If a family was removed after publication, the Server omits it from the
manifest. The text then uses `fontFamily`. The manifest remains valid.

## Plugins

A Plugin API v2 plugin can let a person choose a library family. The plugin
owns the setting. The library owns the families and the files.

1. The plugin stores the family ID in its own table. Countdown Bar adds the
   nullable `font_id` column to its instances. The Studio form uses the shared
   `FontPicker` component (`@tilecast/studio`), which lists the library and
   offers the same **Add fonts** shortcut as the Layout editor.
2. When the plugin saves an instance, it calls `Host.Fonts.UseInTx` in the
   same transaction. The call locks the family row `FOR SHARE`, refuses a
   family that does not exist with `ErrInvalid`, and replaces the
   `font_references` rows of the instance. The plugin calls `ReleaseInTx` when
   it deletes the instance. A plugin can touch only its own rows.
3. `ProjectPlayerState` returns the family IDs in `PlayerState.Fonts`. A state
   entry has at most four families.
4. The Server resolves each ID like a Layout font. It adds the family name and
   the faces to the `fonts` array of the `plugin_state` entry, and it adds each
   face file to the manifest `assets` array once, however many consumers use
   it. A family that was removed, or has no ready face, is dropped from the
   entry.
5. A plugin that requests `player.fonts@1` calls `use(fontId)`. The Runtime
   finds the family in the plugin's current entries, registers its faces under
   `tcf-<fontId>`, and returns the family name and a `ready` promise. For a
   family that the entry does not declare, `use` returns `null`.

Plugin API v1 entries and Players without `player.fonts@1` do not receive the
family. The plugin keeps its own face. A plugin that must work on these Players
requests the service as optional.

Player Core accepts the `fonts` key of a `plugin_state` entry with the bounds of
the manifest schema. It treats each face file like a plugin media variant: the
manifest must list the file in `assets`, the file is a verified download, and
the host grants it to the Runtime. A native contribution receives the entry
media only, not the font faces.

## Player Runtime

The Layout projection reads the Layout `fonts` entry. For a text primitive
with a `fontId`:

1. The projection names the generated family `tcf-<fontId>`.
2. The projection lists each face whose file is in the manifest `assets`
   array. Each face carries a `tcmedia://variant/<assetId>/<variantId>`
   source.
3. The projector replaces each source with the URI that the host authorized.
4. The text style uses `tcf-<fontId>`, then the bundled fallback.

If no face file is in the manifest, the projection omits the library family.
A missing face never rejects the Layout.

The DOM renderer registers each face once through the CSS Font Loading API
(`FontFace`). The registration key is the family, weight, style, and
`unicode-range`. The key does not contain the source, because a host can
issue a new capability URI for each activation. A face that fails to load is
removed and can register again later. Auto-fit text fits again when its face
loads.

The renderer accepts a face only if:

- The family matches `tcf-<UUID>`.
- The source is a URI scheme or a same-origin path, without white space,
  quotes, parentheses, or a backslash.
- The weight is one number or two numbers.
- The style is `normal` or `italic`.
- The `unicode-range` matches the CSS grammar.

The runtime document CSP is `font-src 'self' tcmedia:`.

## Player hosts

Browsers fetch a font in CORS mode. The runtime document origin and the
`tcmedia:` scheme are different origins. Each host must allow the runtime
origin to read a media response:

| Host               | Change                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Linux (Electron)   | `tcmedia` is registered with `corsEnabled`. File responses add `Access-Control-Allow-Origin: tilecast://runtime`.   |
| Edge (WPE)         | `tcmedia` is already CORS-enabled. Media responses add `Access-Control-Allow-Origin: tilecast://runtime`.           |
| Windows (WebView2) | `tcmedia` already allows the runtime origin. Media responses add `Access-Control-Allow-Origin: tilecast://runtime`. |
| Android (WebView)  | Media responses add `Access-Control-Allow-Origin` with the app-owned runtime origin.                                |
| Browser Player     | No change. Media URIs are same-origin service worker paths.                                                         |

Images and video load in no-cors mode. The header does not change their
behavior.

## Tilecast Studio

Settings > Fonts lists the library. A person with `settings.manage` can add a
family from the catalog, upload files, and remove a family.

Studio loads each face from `GET /api/v1/fonts/{id}/faces/{faceId}/file`. It
registers the face under the same `tcf-<fontId>` name as the Player Runtime.
The Layout editor font picker lists organization fonts first, then the
bundled fonts. It is the shared `FontPicker` component. Plugin pages use the
same component through `@tilecast/studio`. A plugin supplies its own built-in
choices after the library, for example "Player default".

## API

| Method and path                                | Authority                |
| ---------------------------------------------- | ------------------------ |
| `GET /api/v1/fonts`                            | Signed-in dashboard user |
| `GET /api/v1/fonts/{id}/faces/{faceId}/file`   | Signed-in dashboard user |
| `GET /api/v1/fonts/catalog`                    | `settings.manage`        |
| `GET /api/v1/fonts/catalog/{sourceId}`         | `settings.manage`        |
| `GET /api/v1/fonts/catalog/{sourceId}/preview` | `settings.manage`        |
| `POST /api/v1/fonts/google`                    | `settings.manage`, CSRF  |
| `POST /api/v1/fonts/uploads`                   | `settings.manage`, CSRF  |
| `DELETE /api/v1/fonts/{id}`                    | `settings.manage`, CSRF  |

Error codes: `font_not_found`, `font_exists`, `font_in_use`,
`font_rights_required`, `font_too_large`, `font_unsupported`, `font_invalid`,
`font_catalog_disabled`, and `font_catalog_unavailable`. The audit log records
`fonts.family_added`, `fonts.face_added`, and `fonts.family_deleted`.

## Backup

Font files are media files. A backup that includes the media directory
includes the font files. A restore restores the families, the faces, and the
files together.

## Licenses

Google Fonts families use the SIL Open Font License 1.1, the Apache License
2.0, or the Ubuntu Font License 1.0. These licenses allow self-hosting. The
library records the license of each catalog family. An upload records the
person who confirmed the right to use the font.
