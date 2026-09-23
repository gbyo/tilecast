# Studio Authoring Flow Plan

Studio currently exposes the content data model as navigation. Six of seven primary destinations
are record types, so knowing where to click requires already knowing the schema, and the required
creation order (Data Source → Widget → Layout or Playlist → Screen) is the inverse of how authors
describe intent ("put the lunch menu on the cafeteria TV").

This plan changes the authoring surface. It does **not** change the record model, the content
definition catalog, the manifest contract, or the Player. The four-record split is what buys one
cached dataset shared across consumers, offline playback, and the manifest v13 declarative
boundary; it stays exactly as it is.

Phases are ordered by value and are independently shippable. Each phase leaves the app in a
releasable state.

## Friction this plan addresses, as it stood before Phase 1

Line references point at the code as it was when the plan was written. Rows 1, 2, 4, and 5 are
resolved by Phase 1; row 3 is resolved by Phase 2. They are kept because they are the rationale for
the phases below, not a list of open defects.

| #   | Problem                                                                                                                        | Location                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | The Data Source control is a bare `<select>` of names — no inline creation, no data sample, no status, no empty-state guidance | `apps/dashboard/src/content/DefinitionForm.tsx:196`, `apps/dashboard/src/content/SourceEditors.tsx:3208`                   |
| 2   | Layout text/visibility binding controls silently disable when no source exists                                                 | `apps/dashboard/src/pages/LayoutEditorPage.tsx:3101`, `:3190`                                                              |
| 3   | Usage lists render as unlinked text, so the dependency graph is a dead end                                                     | `apps/dashboard/src/pages/DataSourcesPage.tsx:686-701`                                                                     |
| 4   | "Edit shared Widget" discards layout context and navigates to the Widget _list_                                                | `apps/dashboard/src/pages/LayoutEditorPage.tsx:2888-2901`                                                                  |
| 5   | Field pickers and preview resolve only the hardcoded `dataSourceId` key, but a Widget may reference multiple sources           | `apps/dashboard/src/content/DefinitionForm.tsx:59`, `:79`; `apps/dashboard/src/content/GenericDefinitionEditors.tsx:43-46` |

Problem 5 is a defect, not a preference: `docs/widgets-and-layouts.md:90` states a Widget may
reference more than one Data Source, and the Server follows every `data_source` control for
manifest projection. Studio's second field picker will list the wrong source's fields.

## Assets already in place

Three things make this cheaper than it looks:

- **A modal source editor already exists and is never used from a Widget.** `DataSourceEditor`
  accepts `page?: boolean` (`content/DataSourceEditors.tsx:1420`) and `EditorFrame` renders as a
  focus-managed `role="dialog"`/`aria-modal` overlay when `page` is falsy
  (`content/DataSourceEditors.tsx:1524`). Every call site currently passes `page`.
- **A focus-trapping `Drawer` and a `ViewTabs` primitive exist** in `components/ui/index.tsx:516`
  and `:223`.
- **Most reverse-dependency edges are already returned by the API** — see Phase 3.

## Phase 1 — Create data where you need it — **done**

Goal: an author picking "Menu Board" never has to know a Data Source is a separate record that must
exist first.

Shipped as described, with two deviations recorded under "As built" below.

### 1.1 One shared `DataSourcePicker`

New component at `apps/dashboard/src/content/DataSourcePicker.tsx`, replacing four call-site
families:

- `DataSourceSelect` in `content/SourceEditors.tsx:3208` (8 legacy call sites: lines 1579, 1745,
  1841, 1900, 1961, 2112, 2268, 2349)
- the two raw inline selects in `content/SourceEditors.tsx:1113` and `:1211`
- the `data_source` branch of `content/DefinitionForm.tsx:141-212`
- both binding selects in `pages/LayoutEditorPage.tsx:3127` and `:3201`

Behavior:

- Rows show name, provider, a status dot, and cached record count. `listDataSources` already
  returns `status` and `cachedRecordCount` on every item (`api/types.ts:1361-1381`), so this costs
  no extra requests.
- Keeps the existing compatibility filtering from `DefinitionForm.tsx:158-173`
  (`acceptedDataSourceKinds`, `requiredFields`) and from `compatibleDataSources` in the legacy
  editor.
- A **Connect new data…** row opens `DataSourceEditor` with `page` omitted — the modal path that
  already exists — and selects the newly created source via its existing `onSaved` callback.
- Empty state replaces the dead dropdown: "No compatible data connected yet" plus the same
  Connect action. Never render a disabled control where an empty-state action belongs; this
  removes the silent-disable at `LayoutEditorPage.tsx:3101` and `:3190`.

### 1.2 Sample values, fetched only when needed

`fields` and record data come from the detail and preview endpoints, not the list, so per-row
samples would be an N+1. Fetch `previewSavedDataSource` only for the **selected** source and render
two sample rows beneath the picker. In the layout binding editor, show the resolved value next to
the field name instead of only the `{{field}}` placeholder — `previewValues` is already computed at
`LayoutEditorPage.tsx:1798`.

### 1.3 Fix the multi-source defect

- `DefinitionForm.tsx`: resolve `data_source_field` options from the source selected by the
  _sibling_ `data_source` field rather than the hardcoded `value.dataSourceId`. Add an explicit
  `dataSourceKey` to the field contract (`ContentDefinitionField`) naming which `data_source`
  control a field picker belongs to, defaulting to the single `data_source` field when a definition
  has exactly one. A definition declaring several sources without saying which one a field picker
  belongs to offers **no** fields, rather than silently listing another source's schema.
- `GenericDefinitionEditors.tsx:43-46`: **fetch and gate on** every source referenced by the
  configuration, not just `configuration.dataSourceId`, including sources nested inside a
  `repeating_group`. Rendering stays single-source: the compiled presentation preview takes one
  dataset, so it renders from the first declared source while all of them gate saving. Keying that
  preview by dataset is deliberately out of scope here — see "As built".

### 1.4 Tests

Extend `content/` coverage with: picker lists only compatible sources; empty state offers Connect;
creating through the modal selects the result without navigation; a two-source definition resolves
each field picker against its own source (regression for 1.3).

**Exit criteria** — A Menu Board can be built start to finish, including its CSV source, without
leaving `/widgets/new/<provider>`. No data-source control anywhere renders as a disabled select.

### As built

New modules: `content/DataSourcePicker.tsx` (picker, `ConnectDataNotice`, and the two-step Connect
flow), `content/dataSourceProviderMeta.tsx` and `content/previewRecords.ts` (both extracted so
`content/` and `pages/` do not import each other in a cycle), and the two test suites.

Two deviations from the plan as written:

- **The Connect flow offered a compatible-provider list rather than reusing the full provider
  gallery.** The gallery lived inside `pages/DataSourcesPage.tsx`; importing it from `content/`
  would have created an import cycle, and moving it meant relocating ~420 lines of page code into a
  feature change. **Resolved:** the gallery and the guided create shell now live in
  `content/DataSourceCreateFlow.tsx`, and the page, the Widget editors, and the Layout editor all
  run them. Connecting data from a Widget therefore opens the same catalog gallery and the same
  setup checklist the page opens, in a dialog rather than a route. A Widget's accepted provider
  list still narrows what the gallery offers, and Form Data Sources are excluded everywhere except
  the page, because they are authored through the Forms portal.
- **Multi-source Widgets preview only their first declared source.** All referenced sources are
  fetched and all of them gate saving, so the captured thumbnail is never uploaded with data in
  flight. Rendering several datasets at once would require `DeclarativePresentationPreview` and
  `previewRecordMaps` to accept a keyed set instead of one payload — a change to preview semantics
  that belongs in its own commit, not in a picker change. **Resolved:** the preview now resolves
  each binding against a map keyed `<dataSourceId>:<datasetId>`, matching how the Server compiles
  dataset references, with an unknown name falling back to the primary payload so single-source
  Widgets are unchanged.

Noted while working, not fixed: the shared `Select` primitive renders its trigger as a `<button
role="combobox">` inside a `<label>`, and a label does not name a button, so most select controls in
Studio have no accessible name. This predates Phase 1 and affects every field in the app, so it
wants a single pass over the `Field`/`Select` primitives rather than a local patch here.

## Phase 2 — Make the dependency graph walkable — **done**

Goal: an author can trace `lunch.csv → Today's Lunch → Cafeteria Layout → Cafeteria TV` and back.
This is the change that makes the app feel connected rather than segmented — the edges exist in the
database already and are not rendered as paths.

### 2.1 Edges already available

| Edge                          | Source                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| Data Source → Widgets         | `DataSourceDetail.widgetUsage` (`api/types.ts:1405`), from `media/datasources.go:435`  |
| Data Source → Layout bindings | `DataSourceDetail.bindingUsage` (`api/types.ts:1406`), from `media/datasources.go:439` |
| Widget → Layouts              | `Asset.layoutUsage` (`api/types.ts:745`), from `media/service.go:382`                  |
| Layout → Screens, Schedules   | `Layout.usage` (`api/types.ts:203`)                                                    |
| Playlist → Layouts            | `Playlist.layoutUsage` (`api/types.ts:96`)                                             |

### 2.2 Two edges to add on the Server

- **Widget → Playlists by identity.** `media/service.go:381` and `:544` select only
  `count(DISTINCT playlist_id)`, so `Asset.playlistUsage` is a bare number. Return id and name
  alongside the count, mirroring `layoutUsage`.
- **Playlist → Screens and Schedules.** No reverse edge exists. Add one to the playlist detail
  response, matching the shape of `Layout.usage`.

Without these two, the chain breaks at the playlist hop and cannot reach a screen.

### 2.3 One shared `UsedByPanel`

New component rendering a consistent, **linked** "Used by" panel on every record detail: Data
Source, Widget, Playlist, Layout. Replaces the unlinked `<li>` lists at
`DataSourcesPage.tsx:686-701`. Each entry links to that record, and terminal entries link to the
screen. Include the count summary that already exists so nothing regresses.

### 2.4 Downward chain from a screen

On the screen detail page, expand the assignment card
(`pages/ScreensPage.tsx:1154`) to show the resolved chain for what is assigned: presentation →
widgets → sources, with each source's status. This is where "why is this stale?" gets answered,
and it reuses the same edges in the other direction.

**Exit criteria** — From any Data Source, reach every screen displaying it in clicks. From any
screen, reach every source feeding it.

### As built

Server: `Asset.playlistsUsing` on the detail read (`media/service.go`), and `Playlist.usage` with
screens and schedules (`playlists/service.go`), matching the `Layout.usage` shape. Dashboard:
`content/UsedByPanel.tsx` on the Data Source, Widget, Playlist, Layout, and Media detail views, and
`content/ScreenContentChain.tsx` for the downward walk.

Three notes:

- **The reverse edges are hand-written SQL, so they were verified against a real Postgres**, not
  just compiled. Running them caught two defects that `go build` and `go test` without a database
  both missed: a `starts_on`/`recurrence` fixture that does not match the `schedules` schema, and a
  production query using `SELECT DISTINCT` with `ORDER BY lower(p.name)`, which Postgres rejects
  because the sort expression is not in the select list. The asset query now uses `GROUP BY`, as
  `layoutUsage` already did. Coverage lives in
  `playlists/reverse_usage_integration_test.go` and needs `TEST_DATABASE_URL`.
- **`playlistUsage` stays a count on the list read.** Resolving playlist identities per row would
  add a second per-asset query to a paged endpoint; `layoutUsage` already does that, and this
  change does not make it worse.
- **The downward chain resolves fully for Layouts and partially for playlists.** A Layout's stored
  dependencies already name every Data Source it reaches, including one reached through a text
  binding with no Widget, so the screen page shows each source and its status for one extra list
  read. A playlist links its Widgets instead of resolving their sources, because that is one detail
  request per item on a page that should stay cheap. Closing that leg properly wants a server-side
  resolved-chain read rather than client fan-out, which is more than the two reverse edges this
  phase budgeted. **Resolved:** the playlist detail read now reports the Data Sources reachable through its items, so both legs resolve the whole way for one query instead of a detail request per item.

Also folded in, as planned: **"Edit shared Widget" now opens the Widget** with a `returnTo` path
back to the Layout, replacing a confirmation dialog that navigated to the Widget _list_ and lost the
author's place. `returnTo` is read from the URL, so only in-app absolute paths are honored — a
protocol-relative value falls back to `/widgets`, which is covered by a test.

## Phase 3 — Collapse six nouns into three — **done**

Goal: navigation describes jobs, not tables. Do this after Phases 1 and 2 because it disrupts
muscle memory and is most defensible once the underlying flows are already pleasant.

### 3.1 Target navigation

`Overview · Screens · Content · Presentations · Schedules · Activity · Settings`, replacing the
`Content` and `Compose` groups in `pages/Dashboard.tsx:38-47`.

- **Content** — one library with `ViewTabs` facets for Media, Widgets, and Data. Data moves from a
  visual peer of Widgets to the input side where it belongs, still one click deep, because schools
  genuinely maintain lunch spreadsheets weekly.
- **Presentations** — Playlists and Layouts unified. "Presentation" is already the vocabulary in
  the product: `ScreensPage.tsx:1174` reads "No presentation assigned", and the screen assignment
  is already a single select mixing `layout:` and `playlist:` values
  (`ScreensPage.tsx:867-872`). Playlist-versus-layout becomes a choice inside creating one rather
  than two places to look.

### 3.2 Routes and compatibility

Keep `/assets`, `/widgets`, `/data-sources`, `/playlists`, and `/layouts` as canonical detail
routes to avoid churning every deep link, breadcrumb `resource`, and `handle.search` entry in
`App.tsx:110-220`. Add the new index routes and redirect old indexes, following the existing
`/content` → `/assets` precedent at `App.tsx:122`.

### 3.3 Coordinated updates

- `handle.search` entries feed global search (`components/StudioTopbar.tsx:117`) — relabel to match.
- `BreadcrumbResource` in `navigation/studioRoutes.tsx:4-11` gains no new members; only labels change.
- `pages/Dashboard.test.tsx:45-55` asserts the `Content`/`Compose` headings and exact link order,
  and `components/StudioTopbar.test.tsx` covers search entries. Both need updating with the change,
  not after.
- `docs/widgets-and-layouts.md:123` currently states Studio Content is organized into Media,
  Widgets, and Data Sources sections. That line and the `AGENTS.md` repository map must be updated
  in the same commit.

**Exit criteria** — Seven primary destinations, no orphaned links, every prior URL still resolves.

### As built

`navigation/WorkspaceTabs.tsx` owns both tab sets and the path-matching rule, so the sidebar and the
tab bars cannot disagree about which routes belong to a workspace. The five index pages render the
tab bar above their existing `PageHeader`.

Three notes:

- **No route moved.** Rather than introduce nested `/content/*` and `/presentations/*` trees, the
  tabs link straight to the canonical index routes. `/content` and `/presentations` redirect to the
  first tab of their workspace. Every deep link, breadcrumb `resource`, and `handle.search` entry is
  untouched, so nothing had to be migrated and no redirect chain was created.
- **The tabs are links, not `ViewTabs` buttons.** `ViewTabs` is stateful and button-based, which
  would have made a workspace switch un-openable in a new tab. The `.view-tabs` selectors now also
  match `a`, so the link tab bar inherits the existing appearance exactly — verified by rendering
  both forms against the built stylesheet side by side.
- **`NavLink` alone was not enough.** A workspace entry would go dark as soon as the author switched
  to another of its tabs, so `SidebarLink` takes an `owns` list of paths and computes the active
  class itself. Covered by tests for both workspaces.

The `Data Sources` label became `Data` in the tab bar and the sidebar only. Each page keeps its own
heading (`Data Sources`, `Media`, `Widgets`), because the tab names a category while the heading
names the record type — the product term stays intact in `docs/widgets-and-layouts.md`, the API, and
the database.

Removed as dead: `.sidebar__nav-group` and `.sidebar__nav-label`, along with the three compact and
responsive rules that referenced them. No component emits those classes now.

The follow-up Base Vega navigation pass makes workspace destinations direct, static sidebar links.
The Content, Presentations, and Screens route bars duplicated those links, so they were removed from
their list and editor routes. Screen detail tabs remain because they switch views of the current
screen.

## Phase 4 — Task-first entry — **removed**

The four guided recipes added to Overview were removed. A short, hard-coded list made the Overview
page compete with the complete Widget catalog and implied that calendar, lunch menu, announcements,
and countdown were privileged creation paths. It did not simplify general Widget creation.

Widget creation remains in the Content workspace and the global Create menu. Both lead to the real
provider gallery, which is driven by the complete server catalog rather than a partial list.

## Smaller fixes to fold in

- `LayoutEditorPage.tsx:2888-2901` — "Edit shared Widget" should edit in place in a `Drawer` with a
  banner naming the other consumers, or at minimum navigate to the actual Widget with a
  return-to-Layout breadcrumb. It currently drops the author at `/widgets` with their place lost.
  Fold into Phase 2, which already computes that consumer list.
- Rename the user-facing "Data Sources" label to "Data". It is the most jargon-heavy string in the
  app; authors think "the lunch spreadsheet" and "the Google Calendar". API paths, types, and
  database columns keep the existing name. Fold into Phase 3.

## Sequencing summary

| Phase                    | Scope                   | Server changes  | Doc changes                           |
| ------------------------ | ----------------------- | --------------- | ------------------------------------- |
| 1 — Create data in place | Dashboard only          | none            | none                                  |
| 2 — Walkable graph       | Dashboard + 2 endpoints | 2 reverse edges | none                                  |
| 3 — Nav collapse         | Dashboard + routes      | none            | `widgets-and-layouts.md`, `AGENTS.md` |
| 4 — Task-first entry     | Dashboard only          | none            | none                                  |

Nothing in this plan begins a deferred milestone feature. Phases 1, 3, and 4 are Studio-only.
Phase 2 adds two reverse-dependency reads over relationships the Server already queries for
deletion protection.
