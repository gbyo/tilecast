# Widgets V2 authoring and first-wave migration

**Status:** accepted implementation plan.

This document defines the first major Widgets V2 migration after the Clock
foundation. It covers the Studio Widget authoring redesign, the move from
Studio-specific previews to the shared Widget renderer, the first visual
catalog to migrate, and the cleanup of source-specific pseudo-Widgets such as
Custom RSS.

It builds on:

- [Widgets V2](widgets-v2.md), which defines the runtime/component contract;
- [Tilecast content extension model](content-extension-model.md), which defines
  Widget, Data Source, Plugin, Package, Registry, and Executor ownership;
- [Widgets and Layouts](widgets-and-layouts.md), which defines the current
  content and Data Source contracts.

This plan does not reopen Plugin API v1.

## Core product decision

The creation model is:

> **Users choose what they want the screen to look like first. The source of
> the data is a separate choice.**

That means visual purpose, not upstream provider, defines a Widget.

Examples:

```text
News                    Widget
Ticker                  Widget
List                    Widget
Table                   Widget
Cards                   Widget
Menu Board              Widget
Agenda                  Widget
Weather                 Widget
QR Code                 Widget

RSS / Atom              Data Source
New York Times          Feed preset / Data Source setup
CNN                     Feed preset / Data Source setup
Google Sheets data      Data Source
Weather forecast        Data Source
Menu items              Data Source

Google Slides           Web Integration
Google Sheets — Display Web Integration
```

A source-specific setup may still be a one-click experience. It does not get a
source-specific renderer or persisted Widget type merely to make setup easy.

This distinction is binding for new Widgets V2 work.

## Why this model

The current catalog has useful pieces of this model but mixes them in several
places.

- `news-feed` already separates a reusable visual renderer from RSS-backed
  Apps.
- `custom-rss`, `atom-feed`, and `rss-ticker` still combine acquisition
  and presentation.
- Menu, List, Table, Agenda, Cards, and Weather still depend on legacy editor
  branches rather than first-class Widget modules.
- Google Slides and Google Sheets Display are remote-web integrations, not
  native Widget components.
- Studio still has hand-written legacy preview paths even though Widgets V2
  defines `WidgetMount` as the one rendering path.

The migration should finish the separation rather than recreate these legacy
boundaries in Lit.

## Design research

The following products were reviewed for the parts of their model that apply to
Tilecast:

- Grafana panel editor:
  https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/panel-editor-overview/
- Grafana 13 query editor:
  https://grafana.com/whats-new/2026-04-01-revamped-query-editor-experience/
- Home Assistant 2026.6 card picker:
  https://www.home-assistant.io/blog/2026/06/03/release-20266/
- Home Assistant custom card editor contract:
  https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/
- Storybook controls:
  https://storybook.js.org/docs/essentials/controls
- Xibo Data Widgets and DataSets:
  https://account.xibosignage.com/manual/en/layouts_editor_data_widgets
  https://account.xibosignage.com/manual/en/media_datasets
- Yodeck app/catalog model:
  https://www.yodeck.com/docs/user-manual/apps-introduction/

Tilecast should borrow:

- a persistent, large live preview while authoring;
- a clear separation between data and appearance;
- real previews when selecting visual styles;
- reusable Data Sources independent from Layouts/Widgets;
- scaffolded, declarative authoring metadata.

Tilecast should not copy:

- provider-specific visual modules when the same visualization works with any
  compatible source;
- arbitrary frontend code as an editor extension point;
- a giant application object passed into Widget code;
- source-specific Player rendering;
- dozens of nearly identical news/weather apps.

## 1. The Widget editor is redesigned for Widgets V2

The existing Widget editor is transitional. Widgets V2 should not preserve it
as the long-term authoring shell.

The new editor is a full-page authoring surface with two primary areas:

```text
+-------------------------------------------------------------------+
| < Widgets        Widget name                    Preview   Save      |
+--------------------------------------------+----------------------+
|                                            |                      |
|                                            | Data                 |
|                                            | -------------------  |
|          REAL WIDGET PREVIEW               | Connected source     |
|                                            | field mapping        |
|          WidgetMount                       |                      |
|          same component as Player          | Content              |
|                                            | -------------------  |
|                                            | headings/options     |
|                                            |                      |
|                                            | Appearance           |
|                                            | -------------------  |
|                                            | style/theme/density  |
|                                            |                      |
|                                            | Behavior             |
|                                            | -------------------  |
|                                            | empty/skip/time      |
+--------------------------------------------+----------------------+
```

The preview is the main workspace. The inspector is the authoring surface.

This is not a miniature Layout editor. A Widget owns its internal responsive
composition; the author chooses data, content options, bounded styles, and
behavior.

### 1.1 Header

The editor header owns:

- Back;
- editable Widget name;
- read-only state when the user lacks content permission;
- preview-size control;
- preview-time control when the Widget is time-aware;
- Save.

Description belongs in a secondary details area rather than occupying the main
editing flow.

Save remains explicit. Do not autosave every control change to the Server.

### 1.2 Inspector sections

Use the same generic inspector shell for every V2 Widget.

Sections are shown only when the Widget declares relevant fields.

#### Data

Contains:

- current Data Source;
- connection health/last refresh when relevant;
- Change source;
- Create new source;
- field mapping;
- attribution notice when required;
- source-specific diagnostics.

A static Widget such as Clock or QR Code has no Data section.

#### Content

Contains semantic author choices:

- heading;
- text;
- item count;
- fields to show;
- date/time choices;
- optional labels;
- QR payload;
- forecast detail choices.

#### Appearance

Contains bounded visual choices:

- visual style;
- density;
- accent/background choices where the Widget allows them;
- dividers;
- image visibility;
- alignment when meaningful.

Do not expose arbitrary CSS, pixels, font sizes, padding, or internal component
layout.

#### Behavior

Contains behavior that affects playback or local evaluation:

- skip when empty;
- empty-state behavior;
- ordering;
- temporal selection;
- animation/motion choice where appropriate.

Do not put Data Source refresh policy here. Refresh belongs to the Data Source.

### 1.3 Inspector metadata is declarative

Do not build one React editor component per Widget.

The Widget manifest/configuration schema remains the source of authoring
controls. Extend the authoring metadata only where the first V2 Widgets prove a
need.

Each field can declare, directly or through a small referenced authoring
descriptor:

- section: `data`, `content`, `appearance`, or `behavior`;
- control type;
- label and help text;
- ordering;
- conditional visibility;
- compatible Data Source kinds/types;
- suggested semantic field role;
- whether a choice is presented as a visual style card rather than a dropdown.

Do not add arbitrary React editor entry points for built-in or plugin Widgets.

A future external Widget should be authorable through the same metadata.

### 1.4 Visual style choices

A small set of meaningful Widget styles may be shown as visual cards.

For example News could offer:

```text
[ Lead story ] [ Headlines ] [ Compact ]
```

These are variants of one Widget, not separate Widget types.

Use the real V2 component for style previews when the number of variants is
small and performance remains bounded. Reuse the active editor resources and
preview context.

Do not render a grid of dozens of live components. The normal Widget gallery
keeps lightweight schematic thumbnails.

## 2. Studio preview moves completely to the shared Widget renderer

Widgets V2 has one renderer. Here, **shared Widget renderer** means the Widget runtime module plus `WidgetMount`; it does not mean the complete `@tilecast/player-runtime` playback document or XState engine. Studio is a host of the Widget renderer, not a Player Runtime host.

That distinction is intentional. Studio supplies authoring-specific context (manual preview time, author locale/timezone, preview mode), locally edited configuration, preview resources, and intrinsic preview geometry. Playback-only lifecycle, staging, transitions, evidence, synchronization, host bridges/capabilities, remote-web surfaces, and failure policy stay in the Player Runtime.

The V2 preview path is:

```text
tilecast.widget.json
        |
        v
Studio V2 discovery
        |
        v
WidgetRegistry
        |
        v
WidgetPreviewHost
        |
        v
WidgetMount
        |
        v
the real Lit/Web Component
```

There is no Studio-specific implementation of News, Weather, Menu, Agenda, or
any other migrated V2 Widget.

### 2.1 New generic `WidgetPreviewHost`

Add one Studio component that adapts React editor state to `WidgetMount`.

It owns:

- a container element;
- the Studio Widget registry;
- component type/version;
- locally compiled component config;
- prepared preview resources;
- preview `WidgetContext`;
- mount lifecycle and disposal;
- ready/empty/error UI;
- snapshot readiness.

It does not own Widget-specific rendering.

### 2.2 Compile V2 preview configuration locally

For a V2 Widget, Studio already has:

- the Widget manifest;
- the author configuration;
- the runtime definition;
- `compileComponentConfig()`;
- `WidgetMount`.

Therefore changing a normal V2 configuration field must not make a
`compileWidgetPreview` Server request on every keystroke.

Studio should:

1. validate/bound the local configuration enough to keep the editor stable;
2. compile `component.configTemplate` locally with
   `compileComponentConfig()`;
3. call `WidgetMount.update()`;
4. keep the same mounted element when type/version are unchanged.

This preserves Widget timers, controllers, transitions, and local state across
ordinary edits.

The Server remains authoritative on save. Create/update still runs Server
validation and rejects invalid persisted configuration.

The old compile-preview endpoint remains only for legacy compatibility
presentations while legacy Widgets exist.

### 2.3 Preview resource adapter

Create one Studio `WidgetResources` adapter.

It receives the set of Data Source IDs declared by the component presentation
or local author configuration and loads the corresponding saved-source preview
documents.

It exposes only those resources to the Widget.

For each connected source it supplies:

- typed Data Document/datasets;
- attribution;
- permitted managed media aliases when that capability lands.

It does not expose:

- arbitrary API access;
- source credentials;
- Editor/React objects;
- unlisted Data Sources.

Preview resources use the same resource shapes as Player resources.

### 2.4 Preview context

The editor uses a real `WidgetContext` with:

- organization locale;
- organization timezone;
- organization hour-cycle preference;
- Tilecast display theme plus author overrides;
- reduced-motion preview state;
- `mode: "preview"`;
- manual corrected clock.

The existing manual preview-time control updates the preview clock rather than
feeding a parallel renderer.

Time-aware Widgets such as Agenda and Weather can therefore be inspected at a
different date/time without changing the Widget implementation.

### 2.5 Preview sizes

Widgets V2 responds to its container, not to a device enum.

The editor offers a small set of useful container presets:

- Landscape screen — 16:9;
- Portrait screen — 9:16;
- Wide strip;
- Tall sidebar;
- Small zone.

Also allow a bounded resize handle or width/height control for testing
intermediate shapes.

These are preview container sizes only. They do not become Widget
configuration.

Use the same canonical frames as Storybook visual fixtures where practical.

### 2.6 Layout editor preview

The Layout editor must use the same `WidgetPreviewHost`/registry/resource
adapter for V2 placements.

It passes the actual zone dimensions.

Delete V2 provider switches from `WidgetLivePreview.tsx` as each family
migrates.

The compatibility preview remains only for Widgets that have not yet migrated.

### 2.7 Other Studio surfaces

After the Widget editor and Layout editor are stable, reuse the same host for:

- Widget snapshot capture;
- playlist item preview;
- any future picker that needs a real preview.

Do not fork a third preview renderer.

The gallery itself keeps `WidgetThumbnail.tsx` schematic thumbnails because
they are fast navigation aids and do not pretend to show live user data.

## 3. Visual-first creation flow

The gallery asks:

> What should this screen show?

not:

> Which service do you want to connect?

The first-wave visual catalog is:

### Essentials

- QR Code

### Information

- News
- Weather
- Agenda

### Data display

- List
- Table
- Cards
- Menu Board
- Ticker

Google Slides and Google Sheets Display remain integrations and may remain in
an Integrations group outside the native V2 visual catalog.

### 3.1 Creating a data-driven Widget

Example:

```text
Widgets
  -> New
  -> News
  -> News editor opens
       Data
         No source connected
         [Connect data]
```

Connect data opens a compatible-source chooser inside the Widget flow.

It offers:

1. existing compatible Data Sources;
2. create a compatible Data Source;
3. useful presets supplied by those Data Source definitions.

The user returns to the same Widget editor after creating a source.

Do not navigate them to the global Data Sources page and make them restart
Widget creation.

### 3.2 Source setup presets belong to the Data Source side

A New York Times or custom RSS shortcut is not a Widget type.

The Feed Data Source can expose safe setup presets such as:

```text
New York Times
CNN
Custom RSS / Atom URL
```

The News and Ticker editors discover these because Feed is a compatible Data
Source.

The Widget does not contain publisher endpoints or publisher-specific parsing.

This preserves:

```text
Widget = presentation
Data Source = data
```

and allows the same Feed source to drive News, Ticker, List, Cards, or Table.

### 3.3 Managed source lifecycle

Creating a Data Source inside a Widget editor may create it as a managed
source, preserving the useful current App-recipe behavior.

Rules:

- the managed source is a real Data Source row;
- editing the source from the Widget updates that same source;
- if no other content uses it, deleting the Widget may delete the managed
  source;
- once another Widget/Layout uses it, Tilecast promotes it to an ordinary
  shared Data Source rather than deleting it;
- the relationship is generic and not tied to RSS or News.

Do not create hidden provider-specific storage.

## 4. Compatible Data Sources and semantic field roles

Type compatibility is necessary but not sufficient for a good authoring
experience.

A generic records Data Source may have:

```text
headline
published
cost
starts
place
```

while the Widget expects semantic concepts.

Add an optional, small semantic-role vocabulary to Data Source output fields.

Initial roles should exist only because a first-wave Widget consumes them.

### Feed/news roles

- `headline`;
- `summary`;
- `published_at`;
- `source_name`;
- `author`;
- `link`;
- `image`.

### Menu roles

- `title`;
- `description`;
- `price`;
- `category`;
- `availability_start`;
- `availability_end`.

### Agenda roles

- `title`;
- `start`;
- `end`;
- `location`;
- `description`;
- `category`.

### General roles

Status fields use `status`, `message`, `severity`, `updated_at`,
`effective_at`, and `expires_at`. Do not invent roles for every possible
field. Generic List/Table/Cards can use ordinary type-compatible field
pickers.

### 4.1 Automatic mapping

When a source is connected:

1. match declared semantic roles;
2. then match known legacy keys where required for compatibility;
3. then offer compatible fields by type;
4. allow the author to override every automatic mapping.

There is no provider-ID switch such as:

```text
if provider === "rss"
```

inside the Widget editor.

## 5. First-wave catalog

The migration is a redesign from the display purpose outward. Existing
provider identities remain compatibility concerns, not design constraints.

### 5.1 QR Code

One V2 component:

```text
tilecast.qr-code
```

Replace the conceptual split between QR Code and QR Call to Action.

Authoring:

#### Content

- destination text/URL;
- optional heading;
- optional instruction;
- optional visible short label/domain.

#### Appearance

- foreground;
- background;
- emphasis style if needed.

The component owns:

- QR encoding;
- quiet zone;
- contrast handling;
- responsive arrangement;
- minimum useful code size.

Use a proven QR library. Do not implement the QR algorithm in Tilecast.

Responsive behavior:

- small zone: code first, optional tiny label;
- normal/fullscreen: heading + large code + instruction;
- portrait: vertically centered CTA.

Legacy `qrcode` and `qr-call-to-action` may project to this same component.
New creation shows one **QR Code** card.

### 5.2 List

Component:

```text
tilecast.list
```

Purpose: flexible repeated rows.

Authoring:

#### Data

- Data Source;
- Primary field;
- optional Secondary field;
- optional Leading field;
- optional Trailing field;
- optional Metadata field.

#### Content

- optional heading;
- maximum items.

#### Appearance

- comfortable/compact density;
- dividers;
- emphasis choice where bounded.

Examples:

- announcements;
- bus departures;
- scores;
- staff;
- birthdays;
- headlines.

List must not contain provider-specific behavior.

### 5.3 Table

Component:

```text
tilecast.table
```

Purpose: genuinely tabular records.

Authoring:

- Data Source;
- bounded list of columns;
- field per column;
- column label;
- alignment where meaningful;
- maximum rows;
- density;
- show/hide header.

Formatting is driven by field type and organization regional settings.

Do not expose arbitrary format strings.

Numeric/currency columns align appropriately by default.

### 5.4 Cards

Component:

```text
tilecast.cards
```

Purpose: responsive record cards.

Semantic slots:

- title;
- subtitle;
- body;
- optional image;
- badge;
- metadata.

Layout is container-driven.

Do not expose an arbitrary "columns" count as the primary model. Container
queries choose a suitable card count for the available width, with only a
bounded density/size preference if a real need remains.

Examples:

- people;
- clubs;
- events;
- products;
- recognition;
- news.

### 5.5 Menu Board

Component:

```text
tilecast.menu-board
```

Purpose: item/description/price presentation with optional sections.

Suggested semantic mapping:

- title;
- description;
- price;
- category.

The current `menu-items` Data Source remains the easiest manual source but is
not the only allowed source.

A compatible Google Sheet, CSV, plugin source, or other records source can feed
Menu Board when fields map correctly.

The component owns:

- section grouping;
- price alignment;
- responsive one/two/multi-column layout;
- readable typography;
- empty presentation.

Do not make the author tune raw column counts for common screen sizes.

### 5.6 Agenda

Component:

```text
tilecast.agenda
```

Required semantic concepts:

- title;
- start datetime.

Optional:

- end datetime;
- location;
- description;
- category.

Agenda owns local display-time behavior:

- now/upcoming treatment;
- day grouping;
- relative status;
- removal of ended items;
- midnight rollover;
- DST/timezone correctness;
- offline reevaluation from the corrected Widget clock.

The Data Source owns fetching Calendar/events data.

Agenda should be a showcase of why the V2 component receives a corrected local
clock.

### 5.7 Weather

Component:

```text
tilecast.weather
```

Weather remains one Widget.

Do not create separate Current Weather, Forecast, Hourly Weather, and Portrait
Weather renderers.

The existing Weather Data Source remains acquisition.

The Widget consumes normalized fields such as:

- location;
- condition;
- temperature;
- high;
- low;
- humidity;
- wind;
- precipitation;
- forecast date.

The Widget never knows the weather provider.

Authoring:

#### Data

- Weather Data Source.

#### Content

- show location;
- show current condition;
- forecast-day count;
- show humidity/wind/precipitation.

#### Appearance

- a small set of meaningful styles if needed.

Responsive behavior:

- fullscreen landscape: current conditions + multi-day forecast;
- portrait: strong current condition + stacked forecast;
- wide strip: compact one-line conditions;
- small zone: current temperature/condition with high/low.

Use Tilecast-owned condition icons mapped from normalized conditions. Do not
download provider icon assets on the Player.

The current MET Norway Server implementation may remain the default source.
The visual component is provider-neutral.

### 5.8 News

Component:

```text
tilecast.news
```

News consumes normalized feed/news records.

Suggested roles:

- headline;
- summary;
- published_at;
- source_name;
- author;
- link;
- optional image.

Authoring:

#### Data

- compatible source.

#### Content

- heading;
- maximum stories;
- show summary;
- show publication time;
- show source.

#### Appearance

Initial styles:

- Lead story;
- Headlines;
- Compact.

These are one Widget's styles.

Responsive behavior:

- large landscape: lead story plus supporting stories;
- portrait/narrow: stacked headlines;
- small Layout zone: concise list.

The new visual design should be typography-first until managed remote feed
images are safe and cached by Tilecast.

### 5.9 Ticker

Component:

```text
tilecast.ticker
```

Ticker is not RSS-specific.

Authoring:

#### Data

- records Data Source;
- primary text field;
- optional secondary field.

#### Content/behavior

- optional leading label;
- separator;
- maximum items;
- direction;
- bounded speed.

An RSS/Atom source is one common source.

A manual records source, Google Sheet, plugin Data Source, or other compatible
records source works the same way.

The existing `rss-ticker` provider becomes a compatibility alias that
projects to `tilecast.ticker` with its managed Feed source.

## 6. RSS, Atom, and news providers

### 6.1 Replace new RSS/Atom split with one Feed Data Source

For new creation, expose one:

**RSS / Atom Feed**

The Server detects and parses supported RSS/Atom forms and normalizes them to
one records contract.

Existing persisted `rss` and `atom` providers remain supported.

Do not rewrite existing source IDs solely for naming.

A later new qualified provider identity may be introduced by the content
extension work, but compatibility rows remain valid.

### 6.2 Custom RSS and Atom Feed are no longer Widget cards

Hide these from new Widget creation after News/Ticker V2 is ready:

- Custom RSS;
- Atom Feed;
- RSS Ticker as an RSS-specific visual;
- News Feed as an advanced legacy label.

The visual catalog instead exposes:

- News;
- Ticker;
- List;
- Cards;
- Table.

The Data Source catalog exposes RSS / Atom Feed.

### 6.3 Publisher presets

Feed setup can provide trusted, release-defined presets.

Initial desired presets:

- New York Times;
- CNN;
- Custom RSS / Atom URL.

A preset is configuration for the Feed Data Source, not a Widget.

Do not scrape publisher HTML.

Before a hard-coded publisher preset ships:

- verify a currently functioning publisher-supported or otherwise dependable
  feed endpoint;
- verify freshness in an automated integration/fixture check;
- document attribution/licensing expectations;
- have a clear failure state if the upstream feed disappears.

If CNN does not expose a dependable public feed at implementation time, keep
the CNN preset out of the release rather than shipping a stale legacy URL.
The News Widget architecture remains unchanged.

The same rule applies to NYT or any future publisher.

## 7. Feed images are a generic Data Source-media problem

Do not let News or Cards fetch remote images.

When article/feed imagery becomes part of the redesign, add a generic managed
remote-media path:

```text
remote media URL in Data Source record
        |
        v
Server fetch policy
        |
        + SSRF/redirect policy
        + size/type/decode limits
        + cache/revalidation
        |
        v
Tilecast managed media variant
        |
        v
WidgetResources.media(...)
        |
        v
News / Cards / other Widgets
```

The Widget receives only a host-authorized media URI.

This feature should be reusable by any Data Source, not named for RSS.

News V2 may ship without images first rather than weaken the Widget security
boundary.

## 8. Google Slides and Google Sheets do not become V2 Widgets

### 8.1 Google Slides

Google Slides is a document/slideshow integration.

Keep it on the Web Integration path for the current public/published flow.

Do not wrap the Google embed in a Lit Widget merely to say it is V2.

Future better architecture:

```text
Google Connection
  -> Slides API/export
  -> Tilecast-managed slide images/media
  -> offline-capable slideshow presentation
```

That future path is separate from this first-wave Widget migration.

### 8.2 Google Sheets — Display

The visual spreadsheet embed remains a Web Integration.

Use a clearer display name:

**Google Sheets — Display**

It is for showing the spreadsheet itself.

### 8.3 Google Sheets — Data

Structured rows are a Data Source.

Connect the current published-sheet path to List, Table, Cards, Menu Board,
Agenda, News, or another compatible Widget.

Future Google Connections may add private authenticated Sheets without changing
those Widget contracts.

Do not maintain a third concept called "Google Sheets Widget."

## 9. Compatibility strategy

The V2 redesign must not break saved content or staggered Player upgrades.

### 9.1 Legacy provider identities remain

Existing persisted Widget providers continue to resolve.

Examples:

```text
qrcode
qr-call-to-action
menu
list
table
agenda
cards
weather
news-feed
custom-rss
atom-feed
rss-ticker
espn
bbc-news
...
```

Do not rewrite all asset rows only to change ID formatting.

### 9.2 Several providers may project to one V2 component

Compatibility mapping is allowed.

Examples:

```text
qrcode              -> tilecast.qr-code
qr-call-to-action   -> tilecast.qr-code

news-feed           -> tilecast.news
custom-rss          -> tilecast.news
atom-feed           -> tilecast.news
publisher news apps -> tilecast.news

ticker              -> tilecast.ticker
rss-ticker          -> tilecast.ticker
```

The component receives normalized V2 config.

This is compatibility mapping, not a reason to preserve duplicate visual
modules.

### 9.3 New creation shows only canonical visual choices

Deprecated compatibility providers disappear from the normal gallery when
their V2 replacement is ready.

Existing content remains editable.

Where an old source-specific App has a managed Data Source, the redesigned
editor should present it as the Widget's connected source.

Do not make users understand the legacy App implementation.

### 9.4 Player fallback

Every migrated provider keeps the existing Widgets V2 fallback rule:

- capable Players receive the component presentation;
- older Players receive the current compatibility presentation;
- persisted content does not change merely because a Player is upgraded.

Do not remove the compatibility renderer until the ordinary Widgets V2
platform support/migration policy allows it.

## 10. Editor migration strategy

The new editor and real preview land before the first-wave visual redesigns.

### 10.1 Transitional routing

During migration:

```text
V2 definition
  -> V2WidgetEditor
  -> WidgetPreviewHost / WidgetMount

legacy definition
  -> current editor
  -> current compatibility preview
```

Do not add new provider branches to `NativeAppEditor`.

Every migrated provider removes one old editor branch.

### 10.2 Delete duplicate preview code as families migrate

Targets for eventual removal include V2-only paths from:

- `WidgetLivePreview.tsx`;
- `DeclarativePresentationPreview`;
- provider-specific preview helpers in `SourceEditors.tsx`;
- provider switches that exist solely for Studio preview.

Do not delete a compatibility path while an unmigrated Widget still uses it.

### 10.3 Snapshot capture

Widget thumbnails stored for saved V2 Widgets are captured from the real
`WidgetPreviewHost` only after `WidgetMount` reports `ready` or the
defined empty state.

Capture from a hidden surface that renders the Widget at the canonical
960x540 frame. Do not rasterize the author's selected preview size and
then stretch, crop, or letterbox it: container queries answer differently
at different geometries, so the thumbnail must be its own real render.

Distinguish failure from emptiness. A Widget with no connected source, or
with a source that returns a valid empty dataset, keeps its defined empty
state and stays capturable. A granted connected source that cannot be
loaded is a preview error: it blocks save and capture, and it is never
stored as a blank Widget.

Do not capture while source previews are loading.

Generated `::before`/`::after` content is part of the Widget's pixels.
Preserve it in captures with its computed style.

A snapshot is a library thumbnail, not another renderer.

## 11. Authoring performance

The real component preview must feel immediate.

Requirements:

- ordinary config changes update locally;
- no Server compile request per keystroke for V2;
- Data Source preview requests use React Query caching;
- source changes cancel/ignore stale requests;
- `WidgetMount.update()` is preferred to remounting;
- preview resize changes only the container;
- a Widget with no clock/timer does no periodic work;
- background style-card previews are bounded and disposed when hidden;
- leaving the editor disposes every mount and timer.

Add performance tests for repeated edit/update cycles and preview-size changes.

## 12. Accessibility and keyboard behavior

The editor is normal Studio UI and follows the existing accessible component
library.

Requirements:

- preview is not the only representation of a setting;
- every inspector field has a programmatic label/help relationship;
- style cards are keyboard-selectable radio choices;
- source picker works without drag/drop;
- preview resize has non-pointer controls;
- color selections retain contrast warnings where relevant;
- error/empty/loading preview state is announced without stealing focus;
- Widget shadow DOM does not trap Studio focus unless a future interactive
  Widget explicitly defines that model.

The first-wave Widgets are display-only.

## 13. Testing model

### 13.1 Widget module

Each migrated V2 Widget has:

- config parser tests;
- data resolver tests;
- ready fixture;
- empty fixture when data-driven;
- error fixture when meaningful;
- representative Storybook stories;
- visual regression for canonical frames;
- responsive behavior tests;
- reduced-motion coverage when animated;
- deterministic clock tests when time-aware.

### 13.2 Studio preview host

Test:

- mount/dispose;
- local config compilation;
- in-place updates;
- source resource changes;
- source request race handling;
- manual preview clock;
- locale/timezone/theme propagation;
- ready/empty/error state;
- preview-size changes without remount;
- snapshot readiness.

### 13.3 Editor

Test:

- sections appear only when relevant;
- compatible Data Sources only;
- create-source-and-return flow;
- automatic semantic mapping;
- manual mapping override;
- source diagnostics;
- read-only behavior;
- unsaved changes/discard;
- save validation failures;
- keyboard navigation.

### 13.4 Compatibility

For every migrated legacy provider:

- old persisted configuration still validates;
- exact component config is asserted;
- old Player still receives compatibility presentation;
- capable Player receives V2 presentation;
- Studio opens the new editor when appropriate;
- hidden/deprecated providers cannot be accidentally created anew.

## 14. First-wave implementation sequence

Do not implement all first-wave Widgets in one PR.

### PR 2 — Extension-source and authoring foundation

Complete the immediate source-boundary work required by
[content-extension-model.md](content-extension-model.md):

- explicit Widget manifest API version;
- source/provenance metadata;
- source-aware discovery;
- root and plugin Widget source support;
- cross-source collision checks;
- no Plugin API v1 changes.

This must not add runtime-downloaded Widgets.

If this work lands separately before the authoring work starts, PR numbers below
shift; the dependency order does not.

### PR 3 — Studio V2 editor and shared preview

Build the new authoring foundation before migrating more Widgets:

- `V2WidgetEditor` full-page shell;
- preview-dominant layout;
- generic Data/Content/Appearance/Behavior inspector;
- `WidgetPreviewHost`;
- Studio V2 discovery/registry;
- local `compileComponentConfig()`;
- `WidgetMount.update()`;
- preview `WidgetResources` adapter;
- manual preview clock/context;
- preview-size controls;
- real V2 preview in the Widget editor;
- real V2 preview in Layout zones;
- snapshot capture from the real mount;
- Clock uses this path end-to-end.

Do not redesign Clock again in this PR.

At completion there must be no Studio-specific Clock renderer.

### PR 4 — General data-display foundation

Migrate/redesign:

- QR Code;
- List;
- Table;
- Cards.

Add only the generic authoring metadata needed by these four.

This proves:

- static V2 authoring;
- one-source records binding;
- field pickers;
- repeated content;
- responsive grids/tables;
- type-aware formatting.

Hide QR Call to Action from new creation once QR Code supports its use case.

### PR 5 — Domain-aware displays

Migrate/redesign:

- Menu Board;
- Agenda;
- Weather.

Add:

- first semantic field roles required by these Widgets;
- automatic semantic mapping;
- time-aware preview behavior;
- grouped/category data;
- currency handling;
- normalized weather presentation.

This proves that the generic editor can support domain-aware Widgets without
custom React editors.

### PR 6 — Feed and news model cleanup

Implement:

- one new/canonical RSS / Atom Feed creation experience;
- normalized feed semantic roles;
- News V2;
- Ticker V2;
- source-preset infrastructure on the Data Source side;
- verified NYT preset;
- CNN preset only if a dependable current upstream passes the verification
  gate;
- Custom feed preset;
- compatibility mapping for source-specific legacy Apps.

Hide from new Widget creation when parity is proven:

- Custom RSS;
- Atom Feed;
- RSS Ticker;
- source-specific News Apps;
- old News Feed label if News fully replaces it.

Do not delete their persisted compatibility support.

### PR 7 — Feed media, if required for the News visual target

If the redesigned News experience requires article imagery, add the generic
managed Data Source-media pipeline.

This PR is optional for first release of News V2. Typography-first News is an
acceptable first landing.

Do not bundle an unsafe remote-image shortcut into PR 6.

### PR 8 — Google product cleanup

This is catalog/authoring cleanup, not a Widgets V2 renderer migration:

- keep Google Slides on Web Integration;
- rename Google Sheets visual embed to **Google Sheets — Display**;
- make the Google Sheet structured Data Source easy to discover/connect;
- remove/replace confusing "Google Sheets Data" placeholder wording;
- document future Google Connections path.

No Google provider-specific V2 component is created.

### PR 9 — Remaining Widget catalog migration

After the first wave proves the editor/runtime model, migrate remaining native
Widget families by visual purpose.

Do not expand the V2 editor contract speculatively for every old setting. Each
new capability must be justified by a real migrated Widget.

## 15. First-wave visual quality bar

These are redesigns, not ports.

A migrated Widget must:

- look intentionally designed at 1920×1080;
- remain useful at 1080×1920;
- adapt to wide strips and narrow/tall zones;
- have a clear visual hierarchy visible from signage viewing distance;
- avoid dense dashboard-style chrome;
- avoid tiny labels and controls;
- use `@tilecast/widget-kit` tokens instead of local design systems;
- use container queries rather than provider-specific viewport branches;
- have a useful empty state;
- not look like a generic web card dropped onto a TV.

The component should contain fewer author-facing layout knobs than the legacy
editor whenever responsive design can make the decision automatically.

## 16. Definition of done for the first wave

The first wave is complete when:

1. Clock and every first-wave native Widget use `WidgetMount` in Studio.
2. The Widget editor uses the redesigned V2 authoring shell.
3. The Layout editor uses the same real V2 component for migrated Widgets.
4. No migrated V2 Widget has a hand-written Studio renderer.
5. No migrated V2 Widget needs a provider-specific editor component.
6. Normal V2 config changes do not call the Server preview compiler.
7. Data-driven Widgets connect to reusable Data Sources inside the editor.
8. Compatible-source creation returns to the Widget without losing state.
9. Semantic roles auto-map the domain-aware first-wave Widgets without
   provider switches.
10. News and Ticker are visual types, not RSS types.
11. RSS/Atom is a Data Source concept for new creation.
12. NYT/CNN/custom-feed convenience, where shipped, is implemented as Data
    Source setup/presets rather than Widget types.
13. QR Code replaces the need for a separate QR Call to Action card.
14. Menu Board, List, Table, Cards, Agenda, Weather, News, and Ticker are
    first-class V2 components.
15. Google Slides remains a Web Integration.
16. Google Sheets Display remains a Web Integration.
17. Google Sheets structured rows are treated as a Data Source.
18. Existing persisted providers continue to render through compatibility
    mappings.
19. Older Players continue receiving compatibility presentations.
20. Gallery creation hides superseded source-specific pseudo-Widgets only
    after their replacement is usable.
21. Storybook, visual regression, Studio tests, Player runtime tests, Server
    projection tests, and compatibility tests pass.
22. Adding the next ordinary V2 Widget requires no new Studio preview/editor
    renderer.

## 17. Binding principles

Future first-wave implementation follows these rules unless an ADR explicitly
replaces them:

1. **Choose the visual purpose first; connect data second.**
2. **Widget = presentation. Data Source = data.**
3. **The editor previews the real Widget, not a Studio copy.**
4. **One Widget component renders fullscreen, Layout zones, Studio, and
   Storybook.**
5. **A source-specific shortcut is a setup recipe/preset, not automatically a
   Widget type.**
6. **Visual styles are variants of one Widget when the information design is
   the same.**
7. **The editor is generic and manifest-driven; do not create one React editor
   per Widget.**
8. **Container-responsive design replaces most author-facing layout knobs.**
9. **The Server remains authoritative on persisted writes; Studio may compile
   safe V2 preview inputs locally.**
10. **Legacy provider IDs are compatibility contracts, not the shape of the new
    catalog.**
11. **A Web Integration that appears on a screen is still not a Widget.**
12. **No Widget gets network access to make its preview or playback easier.**
