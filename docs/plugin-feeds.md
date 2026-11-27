# Plugin feeds

A Plugin Manifest API 3 plugin publishes records for Widgets as feeds. The
host stores them, applies operator overrides, imports remote images, and
projects each dataset as an ordinary Data Source. This document is the
contract. The decision record is
[ADR: Plugin Model V3](adr/plugin-model-v3.md), sections 12 and 13.

## Declaration

```json
{
  "services": ["feeds.publish@1", "http.fetch@1"],
  "feeds": [
    {
      "id": "items",
      "version": 1,
      "title": "Menu items",
      "dataset": "instance",
      "instanceKind": "menu",
      "expectedRefreshSeconds": 900,
      "fields": [
        { "key": "name", "label": "Name", "control": "text", "maxLength": 120, "override": "local_until_changed" },
        { "key": "price", "label": "Price", "control": "number", "minimum": 0 },
        { "key": "photo", "label": "Photo", "control": "url", "image": { "connection": "images" } },
        { "key": "contact", "label": "Contact", "control": "text", "maxLength": 80, "personal": { "retentionDays": 30 } }
      ]
    }
  ]
}
```

| Member                   | Rule                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `id`                     | `^[a-z][a-z0-9_]{0,39}$`. Unique in the plugin. It never changes.                          |
| `version`                | 1 or more. A schema change is a new version: `<feed id>@<version>`.                        |
| `title`, `description`   | Display text. At most 80 and 280 characters.                                              |
| `dataset`                | `organization` (one dataset) or `instance` (one dataset for each instance).                |
| `instanceKind`           | Required for `instance`. A declared instance kind.                                         |
| `expectedRefreshSeconds` | 60 to 604,800. How often the plugin publishes.                                             |
| `fields`                 | 1 to 16 fields.                                                                            |

A field is a [configuration schema](config-schema.md) field with the
`plugin` profile and these limits and additions:

- `control` is `text`, `multiline_text`, `select`, `number`, `integer`,
  `boolean`, `date`, `datetime`, or `url`.
- A `text` or `multiline_text` field has a `maxLength` of at most 4,096, the
  Player's bound for one value.
- A field has no `default`. A publication supplies every value.
- `override` is `upstream` (default), `local`, or `local_until_changed`.
- `image` makes a `url` field a remote image through a declared connection.
  An image is always `upstream` and is never `personal`.
- `personal` needs a retention of 1 to 3,650 days.

A plugin declares at most 8 feeds. The Data Source provider identity is
`<plugin id>.<feed id>` and has at most 80 characters. The Go SDK
(`packages/plugin-sdk/go/plugin/feeds_v3.go`) and the Zod schema
(`packages/plugin-sdk/src/feeds.ts`) apply the same rules, and the fixtures in
`packages/plugin-sdk/testdata/manifests` keep them in agreement.

The bounds are the Player Data Document bounds: 16 fields and 2,000 records
for each dataset, an 80-character record ID, and 4,096 characters for each
value.

## Publication

`feeds.publish@1` is a bundled-only service with two operations.

| Operation                   | Input                                                                      | Answer                                             |
| --------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| `feeds.publish@1/publish`   | `feed`, `instance`, `replaces`, `records`, `validUntil`, `connections`     | `dataset`, `revision`, `records`, `imagesQueued`   |
| `feeds.publish@1/revision`  | `feed`, `instance`                                                         | `revision`                                         |

- A publication replaces the complete record set of one dataset. `records:
  []` empties it. A missing `records` member is refused.
- `replaces` is the revision that the publication replaces: 0 before the
  first one. A publication against another revision answers
  `revision_conflict` and changes nothing. Two concurrent publications against
  the same revision: one wins.
- A record has an ID of 1 to 80 characters, unique in the publication, and
  values that the host normalizes with the field schema, like a settings
  document. An unknown field or a wrong type is refused.
- The host measures the publication as canonical JSON after normalization:
  records in order, keys sorted, no white space. At most 512 KiB.
- `validUntil` is in the future. It becomes the dataset's `staleAt` and the
  Data Source's cache expiry, which Players already obey.
- `connections` names, for each image declaration that a record uses, a
  connection record of this plugin with that declaration.
- The plugin identity is the one the host bound. A publication names only a
  feed of this plugin, and an instance of the feed's kind of this plugin.

The host validates the whole publication first. Then one transaction locks
the dataset, checks the revision, replaces the records, applies the override
rules, queues the image imports, writes the projection, and invalidates the
screens. A dataset and its Data Source row are created at the first
publication. The transport bound is 640 KiB of input.

## Data Source projection

A dataset is an ordinary Data Source row with the provider
`<plugin id>.<feed id>`. The dataset ID and the Data Source ID are the same.
The host registers one host-owned provider for each declared feed. The
provider is not plugin code, and there is no `DataSourceProvider` for each
plugin.

- The projection is one `records` dataset with the feed ID, the declared
  fields, and the effective values, in the existing cached payload of
  `data_source_refresh_states`. The Player Data Document carries it with no
  new protocol. A field's Data Document type follows its control; an image is
  `asset`.
- A Widget binds a feed Data Source like any other. The generic Data Source
  editor refuses to change it and links to the plugin's feed page.
- A per-instance dataset belongs to its instance. Deleting an instance whose
  dataset a Widget uses answers `plugin_instance_in_use`. Without a Widget,
  the dataset goes with the instance and its Data Source is deleted.

## Staleness

A dataset that a Widget uses is stale when its last publication is older than
twice `expectedRefreshSeconds`, or when it was never published. The condition
is the ordinary `data_source` incident of Content Health, with the failure
code `feed_stale`. A fresh publication recovers it. The generic Data Source
threshold does not apply to feeds. The feed page shows the same state.

## Overrides

An operator edits a record field on the plugin's feed page in Studio. The
host stores the upstream values and the overrides in separate rows and never
rewrites an upstream value.

| Policy                | Rule                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `upstream`            | No override. The publication always wins.                                                              |
| `local`               | The override always wins, through later publications.                                                 |
| `local_until_changed` | The override wins while the upstream value stays the same. The host removes it when a publication changes the upstream value. |

- `local_until_changed` compares the old upstream value with the new
  upstream value, never the effective value with the new value. An upstream
  value that changes to the same text as the override still removes it.
- A record that leaves the publication takes its overrides with it.
- A new feed version removes every override of the dataset.
- Each removal writes a bounded audit event, `plugin.feed.override_removed`,
  with the plugin, the feed, the dataset, the record ID, the field, and the
  reason (`upstream_changed`, `record_removed`, `feed_version_changed`). An
  audit event never holds a value, and never a personal value. Studio shows
  why an override disappeared.
- An override value is validated like the field's upstream value. A null
  value removes the override.

## Remote images

A `url` field with `image` names a remote image through a declared
connection.

1. A publication validates and commits. It only queues an import for each
   new or changed image URL. It never fetches inside the transaction.
2. A worker fetches the image after the commit through the outbound engine:
   HTTPS only, even when the connection allows plain HTTP for other requests;
   the connection's origins, addresses, and consents; and the OAuth bearer of
   an `oauth2` connection. A provider whose images are on another host
   declares a separate `http` connection for them, so the bearer never goes
   to the image host.
3. The worker reads at most 8 MiB, sniffs the bytes (never the
   `Content-Type`), accepts only the supported image formats, and reads only
   the image header first: at most 8,192 pixels on a side and 40 million
   pixels. Then the normal media inspection runs.
4. The host stores one private plugin asset for each plugin and SHA-256. It
   never deduplicates across plugins. The plugin quota is 512 MiB.
5. The import attaches the asset only while the publication revision, the
   record, and the URL are still current. An import that finishes for an
   older revision attaches nothing.

The original URL never reaches a Player. A failed import leaves the field
empty, keeps the publication, and adds an attention item to the plugin status
with a stable code: `http_refused`, `auth_required`, `fetch_failed`,
`invalid_image`, `image_too_large`, `processing_failed`, or
`quota_exceeded`. A failure that a retry can help, such as a 503, retries up
to 5 times with a backoff from 30 seconds to 30 minutes. The failure record
holds the code only, never a URL or provider text.

### Private plugin assets

A feed image is a private plugin asset: the historical private origin of
`assets` with `owning_plugin`. The same lifecycle serves Forms attachments;
Forms keeps its own audit name. A private asset is never a Media library item
and is never claimable as a library asset.

- A Player receives a grant only for an asset that a current record of a
  Data Source in its manifest names. The Player asset endpoint refuses a
  private asset that no current record names.
- An asset that no current record names is orphaned. After 24 hours the host
  soft-deletes it through the media lifecycle. A record that names it again
  first cancels the discard.
- Backups contain private plugin assets with the other media originals.

## Personal data

A personal feed field declares a retention. The host removes the field's
upstream value, and its override, from records that have not changed for
longer than the retention, in the daily retention pass, and projects the
dataset again. Audit events never hold personal values. Backups keep
personal data until the backup expires.

## Studio

A plugin with feeds gets a **Feeds** page below its route: each dataset with
its record count, last publication, staleness, image problems, and the
Widgets that use it. A dataset's page lists the records as screens show them.
For each field a record shows the upstream value, the override, the effective
value, the policy, the reason an override was removed, and the code of a
failed image import. Reading needs `plugins.use`; an override needs
`plugins.manage`. A plugin writes no editor of its own.

| Route                                                        | Capability       |
| ------------------------------------------------------------ | ---------------- |
| `GET /api/v1/plugins/{pluginId}/feeds`                       | `plugins.use`    |
| `GET /api/v1/plugins/{pluginId}/feeds/{datasetId}/records`   | `plugins.use`    |
| `PUT /api/v1/plugins/{pluginId}/feeds/{datasetId}/overrides` | `plugins.manage` |

## Not in this phase

`feed.stale@1` events, the Player purge list of withdrawn assets, untrusted
feeds and their 72-hour `validUntil` limit, moderation, and `plugin_asset`
fields come in later phases.

## Threat model

| Threat                                                   | Control                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A publication overwrites a concurrent one                | The publication names the revision it replaces, under the dataset row lock.     |
| A publication exceeds Player bounds                      | 16 fields, 2,000 records, 80-character IDs, 512 KiB canonical JSON.             |
| A plugin writes another plugin's dataset                 | The host binds the plugin; datasets are keyed by plugin, feed, and instance.    |
| An operator edit is lost or kept wrongly                 | Separate override rows; the policies compare upstream with upstream.            |
| A remote image reaches a local address or plain HTTP     | The outbound engine with HTTPS forced.                                          |
| An image bomb exhausts memory                            | A bounded read, a header-only size check, then inspection.                      |
| A slow import attaches to newer data                     | Revision, record, and URL checks under the dataset lock.                        |
| A withdrawn image stays available                        | Grants only for current references; discard after 24 hours.                    |
| Images leak across plugins                               | Deduplication by plugin and SHA-256.                                            |
| Personal values reach the audit log                      | Audit events name fields, never values.                                         |
