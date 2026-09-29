# Widgets V2 final catalog

**Status:** binding. This document records the fate of every Widget
provider in the release catalog. The machine-readable table is
[`widgets-v2-catalog.json`](widgets-v2-catalog.json). A Server test
(`apps/server/internal/contentdefs/catalog_decisions_test.go`) compares
that table with the release catalog.

This document completes
[Widgets V2 authoring and first-wave migration](widgets-v2-authoring-and-first-wave.md)
§14 PR 9. It follows [Widgets V2](widgets-v2.md) and the
[content extension model](content-extension-model.md).

## 1. Rules

1. A Widget is a visual purpose. A Data Source, a preset, a style, or a
   field mapping does not make a new Widget.
2. The gallery shows canonical visual Widgets only.
3. A superseded provider ID stays a storage identity. Saved content
   keeps its provider ID and keeps working. Tilecast does not rewrite
   persisted rows to change an ID.
4. A superseded provider is hidden from new creation. Studio opens saved
   content of that provider in the generic V2 editor.
5. Each superseded provider maps into one V2 component through its own
   `component.configTemplate`. The component receives normalized V2
   configuration.
6. A Web Integration shows a remote page in the remote web surface of the
   shared Player Runtime. It is not a Widget component.

## 2. Inventory surfaces

The inventory used these surfaces on `main` at `dd2288a8`:

| Surface                       | Location                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Release definitions           | `apps/server/internal/contentdefs/definitions/*.json`                                        |
| Widget modules                | `widgets/*/tilecast.widget.json`                                                             |
| Studio legacy editor          | `NativeAppEditor` in `apps/dashboard/src/content/SourceEditors.tsx`                          |
| Studio legacy previews        | `WidgetLivePreview.tsx`, `DeclarativePresentationPreview`, `AppPlacementPreview`             |
| Server legacy normalizers     | `apps/server/internal/media/native_widgets.go`                                               |
| Server legacy compiler        | `compileNativeRoot` in `apps/server/internal/playlists/presentation.go`                      |
| Server template compiler      | `compileDefinitionPresentation` (release `presentationTemplate`)                             |
| Player Runtime compatibility  | `packages/player-runtime/src/compat/` (`widget-render.ts`, `presentation-render.ts`)         |
| Android native renderers      | `NativeWidgetPlayback.kt`, `ExpandedWidgetPlayback.kt`, `DeclarativePresentationPlayback.kt` |
| Studio gallery and thumbnails | `WidgetProviderGallery`, `WidgetThumbnail.tsx`                                               |

## 3. Decisions

The fates are:

- **V2**: keep the visual purpose and redesign it as a V2 component.
- **Collapse**: map saved content into another V2 Widget.
- **Style**: map saved content into a style of another V2 Widget.
- **Web**: a Web Integration. It is not a Widget.
- **Compatibility**: hidden. Saved content maps into a V2 presentation.
- **Remove**: delete the provider. No provider has this fate, because
  saved content can exist for every provider.

### 3.1 Essentials

| Provider            | Name              | Fate          | Component               | Notes                                                           |
| ------------------- | ----------------- | ------------- | ----------------------- | --------------------------------------------------------------- |
| `text`              | Text              | V2            | `tilecast.text`         | New canonical provider. It replaces Text Notice for creation.   |
| `text-notice`       | Text Notice       | Compatibility | `tilecast.text`         | Same keys as Text.                                              |
| `clock`             | Clock             | V2            | `tilecast.clock`        | Modes: time, date and time, date, world clocks.                 |
| `date`              | Date              | Collapse      | `tilecast.clock`        | Date mode.                                                      |
| `world_clock`       | World Clock       | Collapse      | `tilecast.clock`        | World clocks mode.                                              |
| `countdown`         | Countdown         | V2            | `tilecast.countdown`    | Count down, count up, recurrence. Not the Countdown Bar plugin. |
| `qr-code`           | QR Code           | V2            | `tilecast.qr-code`      | Shipped in #729.                                                |
| `qrcode`            | QR Code (legacy)  | Compatibility | `tilecast.qr-code`      | Shipped in #729.                                                |
| `qr-call-to-action` | QR Call to Action | Collapse      | `tilecast.qr-code`      | Shipped in #729.                                                |
| `image-notice`      | Image Notice      | Compatibility | `tilecast.image-notice` | Hidden component. A plain image belongs in Media. See §4.       |

### 3.2 Information

| Provider               | Name                 | Fate     | Component          | Notes                                                                       |
| ---------------------- | -------------------- | -------- | ------------------ | --------------------------------------------------------------------------- |
| `news`                 | News                 | V2       | `tilecast.news`    | Shipped in #731.                                                            |
| `weather`              | Weather              | V2       | `tilecast.weather` | Shipped in #730.                                                            |
| `status`               | Status               | V2       | `tilecast.status`  | New canonical provider. Panel and banner styles.                            |
| `school-status-banner` | School Status Banner | Collapse | `tilecast.status`  | Panel style.                                                                |
| `alert-banner`         | Alert Banner         | Collapse | `tilecast.status`  | Banner style.                                                               |
| `agenda`               | Agenda               | V2       | `tilecast.agenda`  | Styles: agenda, now and next, schedule board.                               |
| `now-and-next`         | Now and Next         | Collapse | `tilecast.agenda`  | Now and next style.                                                         |
| `schedule-board`       | School Schedule      | Collapse | `tilecast.agenda`  | Schedule board style; old sizing and column keys stay in the fallback only. |

Status reads any prepared object Data Source through explicit status,
message, severity, and time-field mappings. Panel and banner are component
styles. `school-status-banner` maps to panel; `alert-banner` maps to banner.
Both provider IDs stay on saved Widgets, and their compiled template
presentations remain available to Players without the component. CAP
severities map as follows: Minor to accent, Moderate to warning, and Severe
or Extreme to critical. A date-only effective time starts at midnight in the
screen time zone. A date-only expiry stays active through that local day.

Agenda uses one component for three styles. `agenda` groups by local day and
marks the current event. `now-next` shows the current and next event; when a
saved Now and Next Widget has no usable start mapping, it keeps the source
order. `schedule-board` features the current or next event, updates its
countdown at schedule boundaries, and can show a bounded upcoming timeline.
When the current event has no end, the next event's start is its implicit
end. Without a following event, it ends at the local-day boundary.
The saved `schedule-board` provider keeps its old schema and template for
older Players. The component does not receive the legacy column or font-size
controls.

The Emergency Alerts plugin creates managed `alert-banner` Widgets for
its built-in NWS presentation. The provider stays valid, so the plugin
does not change.

### 3.3 Data display

| Provider                  | Name                    | Fate     | Component             | Notes                                                       |
| ------------------------- | ----------------------- | -------- | --------------------- | ----------------------------------------------------------- |
| `list`                    | List                    | V2       | `tilecast.list`       | Shipped in #729.                                            |
| `table`                   | Table                   | V2       | `tilecast.table`      | Shipped in #729.                                            |
| `cards`                   | Cards                   | V2       | `tilecast.cards`      | Shipped in #729.                                            |
| `recognition-board`       | Recognition Board       | Collapse | `tilecast.cards`      | Name to title, note to body; legacy columns are not mapped. |
| `menu`                    | Menu Board              | V2       | `tilecast.menu-board` | Shipped in #730.                                            |
| `ticker`                  | Ticker                  | V2       | `tilecast.ticker`     | Shipped in #731.                                            |
| `metric`                  | Metrics                 | V2       | `tilecast.metrics`    | One value or a grid of two to six values.                   |
| `stat_grid`               | Stat Grid               | Collapse | `tilecast.metrics`    | Its `metrics` items keep their shape.                       |
| `progress`                | Progress                | V2       | `tilecast.progress`   | Bar, ring, and thermometer styles.                          |
| `fundraising-thermometer` | Fundraising Thermometer | Style    | `tilecast.progress`   | Thermometer style.                                          |
| `spotlight`               | Spotlight               | V2       | `tilecast.spotlight`  | One featured record.                                        |
| `chart`                   | Chart                   | V2       | `tilecast.chart`      | Bar, line, and area. A saved donut shows bars.              |
| `timeline`                | Timeline                | V2       | `tilecast.timeline`   | Milestones. See §5.                                         |

Recognition Board keeps its provider ID and saved configuration. Its
component template maps `nameField` to Cards `titleField`, `noteField` to
`bodyField`, `maxItems` to `maximumItems`, and preserves its heading, empty
message, and colors. The old column count remains available only to the
legacy template fallback.

The news Apps (`news-feed`, `espn`, `custom-rss`, `atom-feed`,
`bbc-news`, `sky-news`, `the-guardian`) and `rss-ticker` are
compatibility identities of News and Ticker. #731 shipped them.

### 3.4 Web Integrations

`website`, `youtube`, `google-slides`, `google-sheets-display`,
`grafana`, `power-bi`, `tableau-public`, `looker-studio`, `airtable`,
`smartsheet`, `canva`, and `notion` are Web Integrations. They keep
their content model. The Studio gallery shows them in one Integrations
group, apart from the visual Widget catalog.

## 4. Image Notice

Image Notice shows one image with an optional caption. A plain image is
Media. An author places Media directly in a playlist, a Layout, or Quick
Present. No visual purpose remains that a new Widget must serve.

Saved Image Notice content must continue to show after the RenderNode
compatibility renderer is removed. The hidden component
`tilecast.image-notice` renders it. The component reads the image only
through the managed media grant of its presentation. The gallery does
not show it, and search does not find it.

## 5. Timeline

Agenda and Timeline have different semantics:

- Agenda shows current and upcoming scheduled events. It removes ended
  events and marks the event that happens now.
- Timeline shows a progression of milestones with a status. Past
  milestones stay on screen as the history of the progression.

The legacy Timeline has date, title, body, and status fields and no
time-dependent selection. It is not an Agenda presentation. Timeline
stays a V2 Widget.

## 6. Data Sources

The School Status Data Source (`school-status`) is a `manual_object`
source with generic fields: status, message, severity, effective time,
and expiry. Nothing in it is specific to a school. The generic Status
Message Data Source (`status-message`) replaces it for new creation and
publishes the same typed object fields with semantic roles. Saved
`school-status` rows keep working. Both sources use the generic
`manual_object` projection; there is no status-specific adapter.

## 7. Studio gallery

The gallery shows these groups:

- **Essentials**: Text, Clock, Countdown, QR Code.
- **Information**: News, Weather, Status, Agenda.
- **Data display**: List, Table, Cards, Menu Board, Ticker, Metrics,
  Progress, Spotlight, Chart, Timeline.
- **Integrations**: the Web Integrations in §3.4.

Superseded providers are not in the gallery and not in search. Their IDs,
schemas, and per-provider component templates remain available to open and
edit saved content. Studio does not rewrite persisted provider IDs.

## 8. Configuration model for migrated providers

Every native provider that declares a component validates writes through
its manifest `configurationSchema`. The legacy Go normalizer of that
provider is removed. These rules keep saved rows editable:

1. When a saved row does not contain a schema key, and the provider's
   `configTemplate` maps that key with a default that reads other saved
   keys, Studio and the Server fill the key from that default. The
   template is the one source of the legacy key mapping.
2. The Server then removes saved keys that the template reads but the
   schema does not declare.
3. A field with `"ui": {"hidden": true}` is validated and kept, but the
   inspector does not show it. Migrated providers use hidden fields for
   `textScale`, `contentPadding`, and other keys that compatibility
   presentations still read.
4. The Server rejects every other unknown key.

## 9. Pull request sequence

| Pull request | Branch                                                   | Scope                                                     |
| ------------ | -------------------------------------------------------- | --------------------------------------------------------- |
| A            | `gibby/widgets-v2-final-1-essentials`                    | This document, Text, Clock modes, Countdown, Image Notice |
| B            | `gibby/widgets-v2-final-2-data-display`                  | Metrics, Progress, Spotlight, Chart, Timeline             |
| C            | `gibby/widgets-v2-final-3-information`                   | Status, Agenda styles, Recognition Board, catalog test    |
| D            | `gibby/android-shared-runtime-1-host`                    | Android hosts the shared Player Runtime                   |
| E            | `gibby/android-shared-runtime-2-playback`                | Android playback and remote web cut over                  |
| F            | `gibby/android-shared-runtime-3-conformance`             | Android conformance, native display code removed          |
| G            | `gibby/widgets-v2-final-4-remove-legacy-widget-renderer` | Support floor, legacy Widget renderer removed             |
