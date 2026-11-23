# Configuration schema

`packages/config-schema` is the one field vocabulary for Widget definitions and
for Plugin Manifest API 3 plugins. It has a TypeScript half (`src/`) and a Go
half (`go/configschema`). The Go half is authoritative on the Server. The
TypeScript half applies the same shape rules in Studio, `pluginctl`, and
`widgetctl`.

`packages/settings-schema` is a different contract. It is the Player
configuration schema. It does not use this package.

## Profiles

One vocabulary has two profiles. A schema is valid for one profile.

| Profile  | Used by                                | Extra members                                  |
| -------- | -------------------------------------- | ---------------------------------------------- |
| `widget` | A Widget definition `configurationSchema` | None                                        |
| `plugin` | Plugin Manifest API 3 settings and instances | The controls `secret` and `connection`, and the `personal` marker |

The validator enforces the difference. A Widget schema that uses `secret`,
`connection`, or `personal` is invalid. The Widget editor does not need to
avoid sending them.

A plugin manifest does not accept `connection` or `data_source` fields yet. Host
connections arrive in a later phase of
[ADR: Plugin Model V3](adr/plugin-model-v3.md).

## Field

A field has a `key`, a `label`, and a `control`. These members are optional:
`labelKey`, `description`, `descriptionKey`, `required`, `default`, `minimum`,
`maximum`, `minLength`, `maxLength`, `options`, `mediaTypes`, `maximumItems`,
`itemFields`, `ui`, and `personal`. The data source members
(`acceptedDataSourceKinds`, `requiredFields`, `dataSourceFieldTypes`,
`dataSourceKey`) belong to Widgets.

### Controls

`text`, `multiline_text`, `number`, `integer`, `boolean`, `select`, `color`,
`date`, `datetime`, `local_datetime`, `time`, `timezone`, `currency_code`, `url`,
`data_source`, `data_source_field`, `media_asset`, `repeating_group`,
`string_list`, `font`, and `weekdays`. The plugin profile adds `secret` and
`connection`.

- `time` is `HH:MM` in 24-hour form.
- `weekdays` is a list of unique whole numbers from 0 (Sunday) through 6. The
  normalizer sorts it.
- `datetime` is stored as an RFC 3339 instant in UTC.
- `font` and `media_asset` hold an ID that the Server checks against the library.
- A schema has at most four `font` fields, and a repeating group holds none.
- A `secret` is top level, has no default, and holds at most 4096 bytes. The
  configuration document never holds its value. The secret store does.

### Authoring hints

The `ui` object steers Studio. These hints are shared by Widgets and plugins:
`section` (`data`, `content`, `appearance`, or `behavior`), `order`,
`visibleWhen`, `hidden`, `styleCard`, `slider`, `advanced`, `semanticRole`,
`legacyKeys`, and `typeFallback`. `inputUnit: "minutes"` shows an integer that is
stored in seconds as whole minutes. The stored value and the bounds stay in
seconds.

`authoringUiOf`, `visibleAuthoringFields`, and `groupAuthoringFields` moved here
from `@tilecast/widget-sdk`. The Widget SDK re-exports them under their former
names, so Widget code does not change.

### Personal data

`personal: { retentionDays }` marks a field that holds personal data. The
retention is from 1 to 3650 days. See
[Plugin Manifest API 3](plugin-api-v3.md#personal-data) for what the host
enforces.

## Value normalization

`Normalize` (Go) and `normalizeConfigValues` (TypeScript) check a configuration
document against a field list. They apply defaults, trim text, lowercase IDs,
write datetimes in UTC, sort weekdays, and refuse unknown keys. They refuse a
value for a `secret` or `connection` field.

The Go version takes a `References` value. The Server implements it to check
that a Data Source, a media asset, or a font exists. The TypeScript version
checks only what a browser can know.

## Shared fixtures

`packages/config-schema/testdata/schemas.json` and `values.json` run in both
halves. Add a case to a file to change a rule in both. A change to a rule in one
half without the other fails a test.

## Compatibility

Widget manifests do not change. `contentdefs.FieldDefinition` is an alias of
`configschema.Field`, so Widget code that names it keeps working. The Widget
value normalizer in `apps/server/internal/media` calls `configschema.Normalize`
and adds its own Data Source and media checks.
