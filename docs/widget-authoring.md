# Widget authoring

**Status:** current contract.

This document defines how Tilecast Studio authors Widgets. Studio has one
Widget editor. Every Widget type opens in it: new and saved Widgets, component
Widgets and web integrations, core and plugin-owned types. A Widget definition
describes what an author can configure and how the Widget renders. The
definition does not describe how Studio edits, saves, or navigates.

Related contracts:

- [Widgets V2](widgets-v2.md) defines the component runtime.
- [Widgets V2 catalog](widgets-v2-catalog.md) defines saved provider mappings.
- [Widgets and Layouts](widgets-and-layouts.md) defines content definitions and
  Data Source dependencies.
- [Plugin API](plugin-api.md) defines how plugins contribute Widget modules.

## Authoring flow

```text
Widget definition
  -> one Widget editor workspace (WidgetEditorWorkspace)
  -> declarative inspector (WidgetInspector)
  -> real component preview, or web integration preview
  -> explicit Save
  -> canonical thumbnail, captured after the save
```

The route `/widgets/new` shows the Widget gallery. The routes
`/widgets/new/:provider` and `/widgets/:id` open the editor workspace. The route
component loads the saved Widget and the catalog, resolves the definition and
its authoring contract, checks permission, and renders the workspace. The route
component does not select an editor by provider.

## Authoring contract

A Widget definition is authorable when it satisfies one of these rules:

| Runtime  | Rule                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native` | The definition declares a `component`. The configuration schema is the inspector. An empty schema is valid; the inspector then shows that the Widget has no settings.                              |
| `web`    | The configuration schema contains the address field. The address field is `webIntegration.urlField`. A definition without `webIntegration` must set `legacyEditor` and must declare a `url` field. |

A disabled definition (`availability.enabled: false`) is not authorable. Studio
shows its availability reason.

Enforcement:

- The Server test `TestEveryCatalogWidgetSatisfiesTheAuthoringContract` checks
  every core definition, Widget module, and bundled plugin Widget with
  `contentdefs.AuthoringProblem`.
- Studio applies the same rules in `widgetAuthoring.ts`. The gallery hides a
  definition that fails them. A saved Widget of such a type opens an
  unsupported state: "Widget type unavailable". Studio never opens another
  editor.
- A native definition whose component is not part of the Studio build also
  opens the unsupported state.
- `architecture.test.ts` fails when a retired editor name returns, when a file
  other than the editor session calls `createWidget` or `updateWidget`, or when
  the editor compares a provider identifier.

This is a breaking pre-1.0 authoring change. A native definition without a
component, or a web definition without its address field, can no longer be
edited in Studio. Saved Widgets of these types keep playing; Studio shows them
as unavailable until the definition is updated.

`legacyEditor` keeps its Server meaning: the Server validates and projects the
configuration with built-in code (`websiteWidgetProvider`,
`youtubeWidgetProvider`, and the legacy compilers). It has no Studio meaning.

## Configuration schema

The inspector renders each field from its `control`:

| `control`           | Inspector control                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `text`              | Input                                                                                    |
| `multiline_text`    | Textarea                                                                                 |
| `url`               | URL input                                                                                |
| `number`, `integer` | Number input. With `ui.slider`, a slider and a number input under one label.             |
| `boolean`           | Switch                                                                                   |
| `select`            | Select. With `ui.styleCard`, a radio group of visible choices.                           |
| `color`             | Color swatch and hexadecimal input. An optional color can be cleared to the theme color. |
| `date`              | Date picker                                                                              |
| `datetime`          | Date and time picker. The value is saved as an RFC 3339 instant.                         |
| `local_datetime`    | Date and time picker. The value is saved as a wall-clock time.                           |
| `timezone`          | Searchable list of IANA zones. An optional field offers the organization time zone.      |
| `currency_code`     | Three-letter input                                                                       |
| `data_source`       | Connected-source row, searchable source list, and **Connect new data**                   |
| `data_source_field` | Field mapping list with an **Auto** or **Custom** note                                   |
| `media_asset`       | Selected-asset row and the Media picker                                                  |
| `repeating_group`   | Accordion with one item for each row                                                     |
| `string_list`       | List of short text entries                                                               |

`string_list` stores an array of strings. It must declare `maximumItems` from 1
to 100. `maxLength` and `minLength` apply to each entry. The Server trims each
entry and removes empty entries. Website `allowedHosts` uses this control.

### Authoring hints

A field may declare a `ui` object. The vocabulary is closed:

| Hint           | Effect                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- |
| `section`      | `data`, `content`, `appearance`, or `behavior`. A field without a section is `content`. |
| `order`        | The order in the section. Fields without an order follow in manifest order.             |
| `visibleWhen`  | One rule, or a list of rules that must all match, with `equals` or `notEquals`.         |
| `hidden`       | The Server keeps and validates the value. The inspector does not show the field.        |
| `styleCard`    | A `select` renders as a radio group of visible choices.                                 |
| `slider`       | A bounded `number` or `integer` renders a slider beside its input.                      |
| `advanced`     | The field shows in the section's **Advanced** group.                                    |
| `semanticRole` | The source field role that automatic mapping prefers.                                   |
| `legacyKeys`   | Source field keys that automatic mapping tries after the role.                          |

The inspector shows the sections as **Data**, **Content**, **Style**, and
**Behavior**, in that order. The `appearance` section shows as **Style**. The
inspector shows only sections that contain a visible field. With one such
section, the inspector shows the fields under a heading. With two or more, the
inspector shows tabs.

A hidden field and a field with a failed `visibleWhen` rule keep their values in
the draft. Validation checks only the fields that the author can see.

### Preview capabilities

A definition may declare `authoring.preview.time: true`. The rendered result of
such a Widget depends on the current instant. Studio then shows the preview-time
control. Studio also shows the control when a connected Data Source uses date
selection. `authoring` never changes validation, projection, or playback.

The current definitions that declare `authoring.preview.time` are `clock`,
`countdown`, `agenda`, `status`, `date`, `world_clock`, `schedule-board`,
`now-and-next`, `alert-banner`, and `school-status-banner`.

## Data Sources

A `data_source` field lists only compatible Data Sources. A source is
compatible when its output kind is in `acceptedDataSourceKinds` and its output
fields satisfy `requiredFields`. **Connect new data** opens the Data Source
creation flow in a side panel. The draft stays open. Studio selects the new
source when the flow finishes.

Automatic mapping runs when the author connects a different source during the
editing session. For each `data_source_field` that reads the source:

1. A current value that the new source still has stays.
2. An empty or stale value receives the suggestion. The suggestion comes from
   the declared role, then `legacyKeys`, then a compatible type.
3. A stale value without a suggestion is cleared.

Studio does not map fields when it opens a saved Widget. Opening a Widget never
changes it. The mapping control shows **Auto** when the current value is the
suggestion and **Custom** when the author chose another field.

## Editor session

`useWidgetEditorSession` is the only owner of these items:

- the saved baseline and the working draft (name, description, configuration);
- the changed state, derived from a stable comparison of draft and baseline;
- validation and the focus on the first problem;
- the save request, the create and update distinction, and query updates;
- Ctrl+S and Command+S;
- the unsaved-changes warning;
- the return route after close, create, and delete.

Preview frame, zoom, fullscreen, and preview time are preview state. They never
change the draft.

A saved Widget opens with its configuration upgraded to the current schema (see
the catalog contract). Studio keeps only the keys the schema declares for a
non-component definition. Studio fills each missing field from its declared
default, as the Server does.

### Save

Save is explicit. Studio does not save automatically. Save is available when the
draft changed, the author can manage content, and no save is running. A new
Widget can be saved before it is edited.

When validation finds a problem, Studio does not send the request. Studio shows
each problem next to its field, opens the section that contains the first
problem, and moves focus to that field. A name problem opens **Widget details**.

The preview state never blocks a save. A save succeeds when the Server accepts
the configuration.

After a successful save, the Server's normalized Widget becomes the baseline. A
change made while the request was running stays in the draft. A failed save
keeps the draft and shows the error with **Retry**.

### Name and description

The name and description are in **Widget details**. The header shows the draft
name in the last breadcrumb through `useEditorHeaderTitle`. **Apply** changes the
draft only. The Server receives the details with the next save.

### Return protocol

The editor accepts `returnTo` only when `inAppPath` accepts it.

- **Back** goes to `returnTo`, or to `/widgets`.
- After a Widget is created without `returnTo`, the route becomes
  `/widgets/<id>` with a replace navigation.
- After a Widget is created with `returnTo`, the route becomes
  `/widgets/<id>?returnTo=<path>&created=1`. **Back** then goes to
  `<path>?newWidget=<id>`.
- An edited Widget never reports `newWidget`.

The unsaved-changes warning covers **Back**, links, browser navigation, and
native host navigation. It does not show when nothing changed. Save, create,
and delete navigate without the warning.

## Preview

A component Widget renders through `WidgetPreviewHost` and `WidgetMount`. This
is the same element that Layout zones, thumbnails, and the Player Runtime
mount. Edits compile locally with the component `configTemplate`. A
configuration that does not compile keeps the last good render beside the
problem.

A web integration previews through the Server presentation compiler and a
sandboxed frame. The frame is the same one that Studio uses for Playlist
previews. A provider may supply a small preview adapter that answers what the
compiler needs for a draft. The YouTube adapter derives the video or playlist
identifier from the edited address. A viewer cannot compile previews; Studio
shows the saved thumbnail when one exists, or an explanation.

The preview is silent when it is healthy. It shows a short status with an icon
for loading, waiting for data, empty, error, or unavailable.

Diagnostics are a narrow capability. Website Widgets show the Player load
reports. App recipes show the health of their managed Data Source. Studio opens
diagnostics from the actions menu.

## Thumbnails

The editor does not capture a thumbnail before a save. After the Server accepts
a save of a component Widget, the editor queues the saved Widget in
`WidgetSnapshotQueue`. The queue is mounted once in the Studio shell, so a route
change does not cancel a capture. The queue renders the saved Widget at the
canonical 960 × 540 frame, waits for the organization regional settings,
captures the render, and uploads it.

When a capture or upload fails, Studio keeps the save and shows the warning
"Preview thumbnail could not be updated." The Widgets library backfill tries
again later. Web integrations show cross-origin frames, so Studio does not
capture them.

## Website and YouTube

Website and YouTube describe their settings in their definitions like every
other Widget. The Server still validates them with `websiteWidgetProvider` and
`youtubeWidgetProvider`. Their saved configurations, manifest projection, and
Player behavior do not change.

| Provider  | Settings                                                                                                                                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `website` | `url`, `backgroundColor`, `zoomPercent`, `scrollX`, `scrollY`, `reloadPolicy`, `refreshIntervalSeconds`, `failureBehavior`, `fallbackImageAssetId`, `loadTimeoutSeconds`, `allowedHosts`, `javascriptEnabled`, `domStorageEnabled`, `cookiePolicy`, `customUserAgent` |
| `youtube` | `url`, `startSeconds`, `endSeconds`, `captions`, `captionLanguage`, `muted`, `volume`, `loop`, `controls`, `playlistPlaybackMode`, `fixedDurationSeconds`, `failureBehavior`, `fallbackImageAssetId`                                                                  |

Studio does not send Server-derived values (`displayUrl`, `kind`, `videoId`,
`playlistId`) back as author input. A cleared optional media field is omitted,
not sent as an empty string.

## Plugin Widgets

A plugin Widget is a Widget module below `plugins/<name>/widgets/`. Its manifest
must declare a component, so it satisfies the authoring contract. Studio
discovers its component from the bundled plugin directory. The gallery shows the
owning plugin, and disables the type when the plugin is not installed. A plugin
uses the same controls and hints as a core Widget. A plugin cannot add an
editor, a save action, or a navigation rule.
