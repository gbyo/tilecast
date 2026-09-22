# Tilecast Studio UI/UX Redesign Plan

**Status:** Final implementation plan  
**Design system:** shadcn/ui + Base UI + Rhea  
**Primary shell block:** `dashboard-01`  
**Authentication block:** `login-03`  
**Future documentation shell:** `sidebar-03` + shadcn/typeset  
**Verified against:** Tilecast `main` after PR #523 and current shadcn/ui documentation on 2026-09-22

---

## 1. Purpose

Tilecast Studio has accumulated several generations of UI patterns: bespoke controls, large global CSS files, page-specific fix styles, different list/table/card conventions, custom dialogs and popovers, and several very large feature files that mix data, domain logic, and presentation.

This redesign is not a cosmetic reskin. It is a product-wide UX and component architecture reset.

The goals are:

1. Make Studio feel like one coherent modern application.
2. Reduce global chrome and expose task-oriented workspaces instead of the underlying data model.
3. Use shadcn/ui's current Base UI components and the compact Rhea style as the default interaction language.
4. Start from official shadcn blocks where they are a good fit instead of recreating their composition by hand.
5. Preserve Tilecast's domain model, routes, APIs, permissions, player behavior, editor models, and existing good workflow work.
6. Remove the old generic Tilecast UI layer and the CSS patch stack instead of porting them forward.
7. Make unique Tilecast experiences—layout editing, playlist authoring, previews, dependency tracing, player operations—feel purpose-built while keeping their surrounding controls consistent.
8. Keep the app dense, fast, quiet, and professional rather than turning it into either an enterprise console or a generic card dashboard.

This document is the implementation source of truth for the Studio redesign.

---

## 2. Verified design-system decision

### 2.1 Use Rhea

Use **Rhea**, not Vega, Nova, Mira, or Spectrum.

Rhea is the best fit for Studio because it is explicitly designed by shadcn as a compact style for focused product interfaces. It keeps the softer shape language of Luma while tightening component size, gaps, menus, fields, cards, and lists without changing Tailwind's global spacing scale.

Use:

- **Style:** Rhea
- **Primitive base:** Base UI
- **Base color:** Neutral
- **Font:** Geist
- **Icons:** Lucide
- **Menu accent:** Subtle
- **Radius:** restrained/medium; do not maximize roundness
- **Primary color:** mostly neutral; Tilecast brand/color should appear only where it carries real product meaning

Do not manually recreate Rhea by copying CSS. Generate the configuration through current shadcn tooling so the registry returns the Rhea-specific component implementations.

Official reference:

- https://ui.shadcn.com/docs/changelog/2026-05-rhea
- https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default
- https://ui.shadcn.com/create

### 2.2 Base UI is intentional

Base UI is the shadcn primitive base for this redesign. It is the current default for new shadcn projects.

This matters because current Base UI shadcn components frequently use the `render` prop rather than the older Radix `asChild` composition style. New code must follow the generated Base UI APIs rather than examples copied from old Radix-based shadcn projects.

Official reference:

- https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default
- https://ui.shadcn.com/docs/components/base/sidebar

### 2.3 Important correction: keep `cmdk`

Do **not** remove `cmdk` merely because Studio is switching to Base UI.

The current shadcn **Command** component still uses `cmdk` under the hood on the Base UI documentation path. Tilecast already has `cmdk`; the redesign should replace Tilecast's hand-composed command-palette UI with the shadcn Command component, but the dependency itself remains legitimate.

Official reference:

- https://ui.shadcn.com/docs/components/base/command

### 2.4 All selected blocks support Base UI

Current shadcn blocks are available in Base UI variants. Once the project is configured for Base UI/Rhea, `shadcn add` resolves the block to the correct base/style instead of requiring a hand conversion.

Official reference:

- https://ui.shadcn.com/docs/changelog/2026-02-blocks

---

## 3. Official blocks to use

### 3.1 Studio shell — `dashboard-01`

Use:

```bash
npx shadcn@latest add dashboard-01
```

`dashboard-01` is the correct starting composition for authenticated Studio. It currently includes:

- `app-sidebar.tsx`
- `nav-main.tsx`
- `nav-secondary.tsx`
- `nav-user.tsx`
- `nav-documents.tsx`
- `site-header.tsx`
- `section-cards.tsx`
- `chart-area-interactive.tsx`
- `data-table.tsx`
- dashboard page composition using `SidebarProvider`, `SidebarInset`, and an inset sidebar

Use the shell/composition, not its example data or information architecture.

The block should be adapted to Tilecast; do not keep demo "Documents" or demo dashboard entities just because they shipped with the block.

Official reference:

- https://ui.shadcn.com/blocks

### 3.2 Sidebar behavior — use `dashboard-01`, borrow `sidebar-07` behavior only

Do **not** install a second sidebar block into the app and combine two generated shells.

Configure the dashboard shell's `Sidebar` as:

- `variant="inset"`
- `collapsible="icon"`

Use the existing shadcn Sidebar behavior for desktop collapse and mobile/offcanvas navigation.

`sidebar-07` is the official reference for icon-collapse behavior if implementation details are needed, but the main app still derives from `dashboard-01`.

The official Sidebar component supports:

- `SidebarProvider`
- `SidebarInset`
- `SidebarTrigger`
- `SidebarRail`
- `collapsible="icon"`
- controlled open state
- mobile sidebar state
- a built-in `Cmd/Ctrl+B` toggle
- `SidebarMenuButton render={<Link />}` for real links
- active state through `isActive`

Official reference:

- https://ui.shadcn.com/docs/components/base/sidebar
- https://ui.shadcn.com/blocks/sidebar

### 3.3 Authentication — `login-03`

Use:

```bash
npx shadcn@latest add login-03
```

`login-03` is currently the muted-background, centered, compact login composition. That is a better match for self-hosted Tilecast than the split-image login blocks.

Keep its layout language, but replace all demo product/provider content with Tilecast's real authentication flow.

Do not add social-provider buttons unless the server actually exposes configured providers.

Official reference:

- https://ui.shadcn.com/blocks/authentication

### 3.4 Future documentation — `sidebar-03` + Typeset

For a future Tilecast documentation site, use:

```bash
npx shadcn@latest add sidebar-03
```

`sidebar-03` is the official sidebar-with-submenus block and is better suited to hierarchical documentation than the main Studio shell.

Pair it with **shadcn/typeset** for rendered Markdown/HTML. Typeset is specifically designed for HTML/Markdown reading rhythm and exposes size, leading, and flow rather than requiring a large prose CSS system.

Do not use Typeset as a wrapper around ordinary Studio pages.

Official reference:

- https://ui.shadcn.com/blocks/sidebar
- https://ui.shadcn.com/docs/typeset

---

## 4. Existing-project installation rules

Tilecast already has a Vite/React dashboard. Do not scaffold a new Vite app over it.

The official Vite instructions distinguish between creating a new project and integrating shadcn into an existing Vite project.

### 4.1 Before running shadcn

The current post-#523 dashboard has a legacy `apps/dashboard/src/components/ui/` directory. shadcn also owns `src/components/ui/`.

Prevent a namespace collision before adding registry components:

1. Move the legacy directory to a temporary location such as:
   `src/components/legacy-ui/`
2. Update legacy imports mechanically.
3. Do not add new code to `legacy-ui`.
4. Delete it progressively as surfaces migrate.
5. The final app must have no `legacy-ui` imports.

Final ownership:

```text
src/components/ui/         # shadcn registry code only
src/components/studio/     # Tilecast shell/application compositions
src/features/...           # Tilecast domain/feature UI
```

Do not restore a generic `components/ui/index.tsx` barrel. Import generated shadcn components from their files.

### 4.2 Configure the existing Vite app

Follow the current shadcn "Existing Project" Vite path:

- install Tailwind CSS and `@tailwindcss/vite`
- add the `@/*` TypeScript path alias to both the Vite app tsconfigs that require it
- add the matching Vite `resolve.alias`
- add `tailwindcss()` to the existing Vite plugin array
- preserve Tilecast's existing:
  - React plugin
  - API/dev proxy
  - `/healthz` and `/readyz` proxying
  - sourcemaps
  - Vitest setup
- run shadcn init in the existing dashboard rather than replacing the Vite app

Use shadcn/create to select the exact Rhea/Base UI/Neutral/Geist/Lucide preset. Do not hand-author the style from memory.

After initialization run:

```bash
npx shadcn@latest info
```

Verify the detected framework, component base, style, paths, and installed components.

Official reference:

- https://ui.shadcn.com/docs/installation/vite
- https://ui.shadcn.com/docs/cli

### 4.3 Do not add every component

Do not run a blanket "add all".

Add the required blocks first, then install canonical components as the feature migration reaches them. This keeps the generated registry auditable and prevents unused dependencies/code.

---

## 5. Fine-detail API rules

These are important because current Base UI shadcn examples differ from older shadcn code found on the web.

### 5.1 Base UI composition uses `render`

For supported Base UI triggers and polymorphic pieces, prefer the generated `render` API.

Example pattern:

```tsx
<SidebarMenuButton render={<NavLink to="/screens" />} isActive={active}>
  <Monitor />
  <span>Screens</span>
</SidebarMenuButton>
```

Do not mechanically copy old `asChild` examples from Radix tutorials.

### 5.2 Buttons that navigate must remain links

Current Base UI shadcn Button documentation explicitly warns against rendering an anchor through Button because Base UI Button applies `role="button"`.

For actions that navigate:

```tsx
<Link
  to="/screens/pair"
  className={buttonVariants({ variant: "default" })}
>
  Pair screen
</Link>
```

Use `Button` for actions and `Link`/`NavLink` for navigation.

This also preserves open-in-new-tab, copy-link, browser status preview, and normal link semantics.

Official reference:

- https://ui.shadcn.com/docs/components/base/button

### 5.3 Route navigation is not Tabs

shadcn Tabs are for layered sections/panels displayed one at a time. Tilecast's top-level workspace facets are distinct canonical routes.

Therefore:

- **Content: Media / Widgets / Data** → route navigation
- **Presentations: Playlists / Layouts / Campaigns** → route navigation
- **Screens: Fleet / Display Groups / Archive** → route navigation

Implement a small Tilecast domain component such as `WorkspaceNav` using a semantic `<nav>` and React Router `NavLink`s, styled to visually harmonize with the Rhea line-tab treatment.

Do not use `TabsTrigger` to masquerade distinct routes as local tab panels.

Use actual shadcn Tabs for state within one resource/page, such as:

- Screen detail: Overview / Content / Activity / Device / Settings
- Activity report modes if they remain one route/query-state view
- Form editor: Form / Workflow / Responses / Access
- Layout left pane: Content / Layers

This distinction preserves browser behavior and correct semantics.

Official reference:

- https://ui.shadcn.com/docs/components/base/tabs

### 5.4 Date Picker is a composition, not a root primitive

Current shadcn Date Picker is a documented composition of:

- `Popover`
- `Calendar`

Use the documented composition instead of expecting a single `DatePicker` component.

Its examples include date range, input-backed date selection, and date + time.

Official reference:

- https://ui.shadcn.com/docs/components/base/date-picker

### 5.5 Data Table is intentionally feature-specific

Current shadcn Data Table documentation explicitly says not to force every datagrid into one universal implementation. The guide currently uses **TanStack Table v9** and feature registration.

Tilecast should follow that philosophy.

Share small helpers:

```text
data-table-column-header.tsx
data-table-pagination.tsx
data-table-view-options.tsx
```

but build feature-specific tables for Screens, Data Sources, Activity, Users, Approvals, etc.

Do not create `UniversalDataTable<T>` with dozens of props.

Official reference:

- https://ui.shadcn.com/docs/components/base/data-table

### 5.6 Drawer has one required global detail

Current Base UI Drawer documentation requires a positioned `body` for its overlay behavior on iOS Safari after scrolling:

```css
body {
  position: relative;
}
```

If Tilecast uses Drawer for responsive/mobile surfaces, include and document this intentionally.

Official reference:

- https://ui.shadcn.com/docs/components/base/drawer

### 5.7 Attachment is appropriate for the upload queue

The Base UI Attachment component supports:

- icon/image media
- metadata
- actions
- `idle`
- `uploading`
- `processing`
- `error`
- `done`
- default/sm/xs sizing
- full-card trigger
- groups

Use it for Media upload queue items rather than inventing another upload-row component.

Official reference:

- https://ui.shadcn.com/docs/components/base/attachment

### 5.8 Questionnaire has a narrow purpose

Questionnaire currently owns ordered questions, active item, answers, validation, progress, navigation, shortcuts, and optional skipping. The host owns cancellation, persistence, transport, and branching.

Use it for:

- initial organization setup
- guided "Create form" setup

Do not use it for:

- ordinary settings
- MFA enrollment just because it has several steps
- the full Form editor
- playlist/layout editors

Official reference:

- https://ui.shadcn.com/docs/components/base/questionnaire

### 5.9 `Marker`, `Bubble`, `Message`, and `Message Scroller` are not general Studio status components

Current Marker is explicitly conversation-oriented. Bubble/Message/Message Scroller are also chat/conversation primitives.

Do not force them into fleet health, activity logs, or editor UI just to use more components.

Use Badge, Alert, Item, Progress, Skeleton, and ordinary semantic text instead.

### 5.10 Button Group vs Toggle Group

Use:

- **Button Group** when controls are related actions
- **Toggle Group** when controls select persistent state/mode

Examples:

Button Group:
- Undo / Redo
- zoom minus / reset / plus
- Restart / restart options

Toggle Group:
- Grid / List
- alignment
- preview size mode
- Light / Dark / System if represented as one-of-many controls

---

## 6. Product-wide visual rules

The following rules are part of the design specification, not optional polish.

### 6.1 Overall character

Tilecast should feel:

- compact
- calm
- precise
- fast
- content-first
- modern
- desktop-capable

Tilecast should **not** feel:

- like an Adobe enterprise suite
- like a generic "AI SaaS dashboard"
- like every section is a Card
- excessively rounded
- spacious for the sake of spaciousness
- decorative instead of functional

### 6.2 Cards are objects, not sections

Use Card for:

- small dashboard metrics
- plugins
- visual resource cards where a bounded object is meaningful
- occasional contained setup/empty-state composition

Do not wrap every page section, inspector group, or settings group in a Card.

Use:

- headings
- whitespace
- Separator
- Item
- Table/Data Table
- muted backgrounds

for hierarchy.

### 6.3 Avoid "card soup"

Nested Card inside Card is almost always wrong in Studio.

A common settings page should look like a form, not a grid of panels.

An editor inspector should look like a property inspector, not stacked dashboard cards.

### 6.4 Keep headings restrained

Normal application pages should not spend 150px of vertical space announcing their title.

Page header pattern:

```text
Title                                      [primary action]
Short description if useful
workspace nav / tools
```

On dense editor routes, the resource title belongs in the editor toolbar.

### 6.5 Contextual actions beat global actions

Do not permanently place "Pair screen" and "Create" in the global header.

Put creation where the user is working:

- Screens → Pair screen
- Media → Upload
- Widgets → New widget
- Data → New source
- Playlists → New playlist
- Layouts → New layout
- Schedules → New schedule
- Plugins → plugin-specific create action

The global Command palette may expose all quick actions.

### 6.6 Use width

Data tables and editors should use the workspace width.

Do not constrain operational pages into narrow centered columns.

Long prose/help content may be constrained.

### 6.7 Status must not rely on color

A colored dot alone is never the complete status indicator.

Always pair status color with a text label, icon, accessible name, or other non-color signal.

---

## 7. Global information architecture

The global sidebar should contain only major workspaces.

### Main

- Overview
- Screens
- Content
- Presentations
- Schedules
- Plugins

### Monitor

- Activity
- Approvals — only when the current capability logic allows it

### Manage

- Settings

### Footer

- User/avatar
- account menu
- My Forms
- My Account
- Sign out

Do not permanently expand record-type children in the global sidebar.

### Workspace route navigation

Screens:

- Fleet → `/screens`
- Display Groups → `/groups`
- Archive → `/screens/archive`

Content:

- Media → `/assets`
- Widgets → `/widgets`
- Data → `/data-sources`

Presentations:

- Playlists → `/playlists`
- Layouts → `/layouts`
- Campaigns → `/campaigns`

These remain canonical routes.

---

## 8. Global shell

### 8.1 AppSidebar

Adapt `dashboard-01`'s AppSidebar.

Recommended composition:

```text
Sidebar
├── SidebarHeader
│   └── Tilecast brand
├── SidebarContent
│   ├── SidebarGroup (main)
│   │   └── SidebarMenu
│   └── SidebarGroup (monitor)
│       └── SidebarMenu
├── SidebarFooter
│   ├── Settings
│   └── user menu
└── SidebarRail
```

Use:

```tsx
<Sidebar variant="inset" collapsible="icon">
```

Do not build manual compact-mode CSS.

Persisting expanded/collapsed preference is optional. If retained, use SidebarProvider's controlled state rather than a second custom sidebar state system.

### 8.2 Sidebar width

Start from the block's intended proportions, then keep Tilecast's expanded sidebar restrained. Do not return to the wide Spectrum sidebar.

Do not reduce it so far that labels truncate constantly.

The collapsed state is the solution for users who want maximum workspace.

### 8.3 SiteHeader

Adapt `dashboard-01` `site-header.tsx`.

Desired content:

```text
[SidebarTrigger] [Breadcrumb]                   [Search Tilecast ⌘K] [Notifications]
```

Keep it visually quiet.

Do not add persistent Create or Pair buttons.

### 8.4 Breadcrumbs

Preserve the current route-handle/breadcrumb-resource logic from `studioRoutes`.

Use shadcn Breadcrumb for presentation.

Keep dynamic resource names when they are currently resolved.

### 8.5 Command palette

Keep:

- current `fuzzyScore`
- route search metadata
- permission filtering
- screen/resource providers
- quick actions

Rebuild the UI with shadcn:

- `CommandDialog`
- `CommandInput`
- `CommandList`
- `CommandGroup`
- `CommandItem`
- `CommandShortcut`
- `Kbd`

Keyboard shortcut remains Cmd/Ctrl+K.

Because shadcn Command still uses `cmdk`, keep the dependency.

Remove Tilecast-specific command palette focus hacks once the canonical component handles focus correctly.

### 8.6 Notifications

Use:

- icon Button
- Popover or Dropdown Menu depending interaction
- Badge for count/priority summary
- Item rows inside the list
- links/actions that open the relevant resource

Critical alerts should use text and severity, not a red dot alone.

### 8.7 User menu

Adapt `dashboard-01` `nav-user`.

Use:

- Avatar
- Dropdown Menu
- My Forms
- My Account
- Sign out

On collapsed sidebar, the avatar remains a natural footer trigger.

---

## 9. Shared interaction policy

| User intent | Preferred component |
|---|---|
| navigate | React Router Link/NavLink |
| primary/secondary action | Button |
| related sibling actions | Button Group |
| persistent state/mode | Toggle / Toggle Group |
| overflow action list | Dropdown Menu |
| right-click shortcut | Context Menu |
| simple transient options | Popover |
| inspect complementary details | Sheet |
| mobile bottom/side interaction | Drawer |
| short interrupting task | Dialog |
| destructive/irreversible confirmation | Alert Dialog |
| long complex editor | dedicated route |
| searchable single resource selection | Combobox |
| searchable multi-resource selection | Combobox multiple + chips |
| short fixed enum | Select |
| plain browser-native enum only when intentionally desired | Native Select |
| in-page layered panels | Tabs |
| route-level facets | WorkspaceNav using links |
| long settings categories | semantic settings nav |
| optional one-off section | Collapsible |
| mutually related expandable sections | Accordion |
| temporary mutation result | Toast |
| persistent warning/error | Alert |
| empty collection | Empty |
| initial loading | Skeleton |
| button mutation | Spinner |
| long-running process | Progress |

---

# 10. Surface plans

## 10.1 Overview

### Preserve

Current `OperationsDashboard` already has useful domain/query logic for:

- screens
- schedule state
- player update deployments
- fleet uptime
- attention state
- next schedule change

Keep those data sources.

### New structure

#### Header

```text
Overview

Player health, what's on air, and what needs attention.
```

#### Summary cards

Use compact `section-cards` style composition from `dashboard-01`:

- Online — `14 / 16`
- Needs attention — `2`
- Playing now — count of actively reporting playback
- Next change — relative/absolute next schedule event

Keep the cards small and scannable.

#### Fleet health chart

Use shadcn Chart + Recharts v3.

Recommended range Toggle Group:

- 24h
- 7d
- 30d

Do not wrap Recharts in a second Tilecast chart framework. shadcn intentionally leaves charts close to Recharts.

#### Needs attention

Use `ItemGroup` and `Item size="sm"`.

Example:

```text
HS Cafeteria 2
Offline · last contact 18 minutes ago                  >
```

Link to the Screen.

#### Coming up

Use compact Items showing:

- time
- presentation/schedule
- target summary

#### Empty installation

If no screens exist, do not display meaningless zero-value dashboard analytics as the dominant page.

Show an intentional `Empty`/onboarding composition with **Pair screen** as the primary action, while keeping any useful server/system status below.

### Components

- Card
- Chart
- Toggle Group
- Item
- Badge
- Empty
- Skeleton
- Alert
- Link

---

## 10.2 Screens — Fleet

### Route

`/screens`

### Workspace nav

- Fleet
- Display Groups
- Archive

Use `WorkspaceNav` links, not Tabs.

### Page toolbar

```text
Screens                                              [Pair screen]
16 players across 8 locations

[Search screens...] [Status] [Location] [Version] [Columns]
```

### Table

Build a feature-specific TanStack v9 Data Table.

Columns:

1. selection
2. Screen
   - optional small preview/device glyph
   - screen name
3. Status
4. Now playing
5. Location
6. Platform/device
7. Player version/update state
8. Last seen
9. actions

### Row behavior

Do not make `<tr role="button">`.

Preferred:

- screen name is a real Link
- optional row click may enhance mouse UX only if it does not break selection/links
- keyboard navigation relies on real focusable elements

### Status

Use labeled Badge or text + small status affordance.

### Bulk selection

When rows are selected show a contextual action bar above/below table:

- Present
- Move to group
- restart/command
- update
- More

Keep `/screens/bulk` for changes that genuinely require preview/review, not every multi-select action.

### Pending pair requests

Show a compact Alert or ItemGroup above the table:

```text
2 screens are waiting to be paired                 Review
```

### Components

- WorkspaceNav
- Input Group
- Select/Combobox
- Data Table
- Checkbox
- Badge
- Dropdown Menu
- Button Group
- Alert
- Skeleton
- Empty
- Pagination where API paging requires it

---

## 10.3 Pair Screen

### Routes

- `/screens/pair`
- `/screens/pair/:code`
- `/screens/pair/request/:requestId`

### New flow

Focused page, not a dense admin page.

If the pairing code is a fixed segmented code, use Input OTP. If the actual server code format is not compatible with segmented OTP UX, use a normal Input instead—do not force Input OTP purely for appearance.

Pairing request mode should show known device/request details before confirming.

Success:

- Toast
- route to the new screen detail

Failure:

- inline Alert near the form

### Components

- Card or simple centered form surface
- Field
- Input OTP or Input
- Button
- Alert
- Spinner
- Toast

---

## 10.4 Display Groups

### Route

`/groups`

### Presentation

Screens workspace → Display Groups.

Use a Data Table:

- Group
- Mode
- Screens
- Current presentation
- status
- actions

### Group detail

Resource header + local panels:

- Overview
- Screens
- Content
- Activity if meaningful

If those states are one route, use Tabs.

Member screen list can be simple Table/ItemGroup unless it needs complex sorting/filtering.

Use drag ordering only if ordering has real domain meaning.

---

## 10.5 Screen detail

### Route

`/screens/:id`

### Header

```text
HS Cafeteria North
Online · Fire TV 4K Max · Player 1.14.2

[Present] [Restart] [More]
```

Only one obvious primary action.

### Tabs

- Overview
- Content
- Activity
- Device
- Settings

These are appropriate shadcn Tabs if they remain layered state inside the resource route. If a future implementation makes them distinct child routes, convert them to link navigation.

### Overview

Large live/snapshot preview plus compact operational summary:

- current presentation
- location
- connection
- version/update state
- uptime/reliability
- next schedule
- active takeover state

Avoid one Card per field.

### Content

Preserve and elevate `ScreenContentChain`.

Show assignment/dependency path:

```text
Screen
  ↓
Lunch Layout
  ↓
Lunch Menu Widget
  ↓
School Lunch CSV — Healthy · refreshed 2m ago
```

Every resource is linked.

This is a core Tilecast differentiator and should feel first-class.

### Activity

Compact recent Items with a "View full activity" route to filtered Activity.

### Device

Use semantic definition-list layout, Item sections, and separators.

### Settings

Show organization-inherited values vs screen overrides explicitly.

Use:

- Switch
- Select
- Field
- Alert for warnings

Do not imply a local override is the global value.

---

## 10.6 Content workspace

Route facets:

- `/assets`
- `/widgets`
- `/data-sources`

Use `WorkspaceNav`.

---

## 10.7 Media

### Route

`/assets`

### Header

```text
Content
Media | Widgets | Data

Media                                                [Upload]
1,284 assets

[Search media...] [Type] [Tags] [Sort]              [Grid | List]
```

### Grid/list switch

Use `ToggleGroup type="single"`.

### Folders

Do not build a generic TreeView just because Spectrum had one.

Use:

- Breadcrumb for current folder
- folder Items/tiles
- `Move to…` Combobox for relocation

This is simpler and more consistent with the available shadcn/Base UI vocabulary.

### Media grid

Create a domain component: `MediaAssetCard`.

This is allowed because a media asset is a Tilecast concept, not a generic design primitive.

Use:

- Aspect Ratio
- real preview
- title
- minimal metadata
- selection state
- Dropdown Menu

Do not create a generic `ResourceCard` that all unrelated entities are forced into.

### List mode

Prefer `ItemGroup` + `Item size="sm"` unless the list becomes column-heavy enough to justify a table.

### Asset detail

Open a right Sheet for contextual details:

- Preview
- Metadata
- Availability
- tags/folder
- Used by

If an edit grows too complex for a Sheet, route to a dedicated editor.

### UsedByPanel

Preserve the existing dependency data and links.

Recompose visually using Items/links/Badge rather than keeping the old CSS panel.

---

## 10.8 Media upload

Replace the custom upload queue presentation with Attachment.

Each queue item maps its real state:

- queued → `idle`
- uploading → `uploading`
- server processing → `processing`
- failed → `error`
- complete → `done`

Use AttachmentDescription for progress/failure text so state is not color-only.

Use Progress only when exact progress adds value.

Closing during active work uses Alert Dialog if the close has consequences.

### Components

- Dialog or Sheet
- Attachment
- Progress
- Alert
- Alert Dialog
- Button
- Spinner

---

## 10.9 Widgets

### Route

`/widgets`

### Library

Visual cards because Widget output is visual.

Each card:

- captured thumbnail/preview
- name
- provider/type
- data/source health if relevant
- usage count
- actions

### Creation

Use a provider gallery, not a fixed Select.

Search can narrow providers if the catalog is large.

### Editor

Use a two-column composition where helpful:

```text
Configuration                         Preview
--------------------------------     ----------------
Name                                  live preview
Data source
field mappings
display options
```

On narrow screens the preview moves above/below.

### DataSourcePicker

Keep the existing good behavior:

- compatibility filtering
- source status
- cached record count
- selected-source samples
- Connect new data
- inline creation
- multi-source resolution

Rebuild the visual control around Combobox where appropriate.

Do not regress the existing "create data where you need it" flow.

### Components

- WorkspaceNav
- Card
- Aspect Ratio
- Combobox
- Field
- Input
- Select
- Switch
- Slider
- Collapsible
- Alert
- Dialog
- Toast

---

## 10.10 Data Sources

### Route

`/data-sources`

### Default view

Data Table:

- Name
- Provider
- Status
- Cached records
- Last refresh
- Used by
- actions

Toolbar:

- Search
- Provider
- Status
- New source

### Editor

Break the giant provider editor code into provider/feature modules.

Suggested architecture:

```text
src/features/data-sources/
  DataSourcesTable.tsx
  DataSourceEditorShell.tsx
  DataSourcePreview.tsx
  DataSourceUsage.tsx
  data-source-form/
  providers/
    csv/
    google-sheets/
    rss/
    calendar/
    ...
```

Use tabs only where the provider has genuinely distinct local panels, such as:

- General
- Connection
- Data preview
- Usage

### Preview

Simple data Table.

### Usage

Recompose existing `UsedByPanel` data.

### Components

- Data Table
- Badge
- Field
- Input
- Input Group
- Select
- Combobox
- Switch
- Textarea
- Tabs when appropriate
- Table for preview
- Dialog/Alert Dialog
- Skeleton
- Toast

---

## 10.11 Presentations workspace

Route facets:

- `/playlists`
- `/layouts`
- `/campaigns`

Use `WorkspaceNav`.

---

## 10.12 Playlist library

### Route

`/playlists`

Visual library.

Each playlist should show:

- real mini preview
- name
- item count
- runtime when meaningful
- source type (standard/tag-driven)
- updated time
- overflow actions

List mode can use Item.

Creation is a short Dialog:

- name
- description
- type if needed

After create, navigate to editor.

### Components

- Card/domain playlist card
- Aspect Ratio
- Toggle Group
- Input Group
- Select
- Dialog
- Dropdown Menu
- Empty
- Skeleton

---

## 10.13 Playlist editor

### Route

`/playlists/:id`

Preserve:

- playlist editor model
- reorder/move logic
- durations
- transitions
- tag-driven behavior
- preview
- revisions
- unsaved-change protection
- API behavior

### New shell

Use an editor-specific top toolbar.

Recommended default:

```text
← Playlists   Morning Announcements          Saved   Preview   More
-------------------------------------------------------------------
Timeline / sequence                         Inspector

1 Welcome slide      8s                     selected item settings
2 Lunch menu        15s
3 Weather           20s
-------------------------------------------------------------------
+ Add content
```

Use `ResizablePanelGroup` for sequence + inspector.

Do **not** permanently consume a third of the screen with a content browser by default.

`Add content` opens a Sheet containing searchable Media/Widgets.

If real usage proves drag-from-library is frequent enough, the browser may later become an optional resizable panel.

### Empty inspector

When no item is selected, show **Playlist settings**:

- default image duration
- default transition
- crossfade
- playback defaults
- tag playlist behavior

### Item inspector

When an item is selected:

- duration
- transition override
- crop/fit
- item properties

Inherited values must be explicit:

```text
Transition
Playlist default — Crossfade 800 ms
```

### History

`More → Version history` opens Sheet.

Do not render revision history as an unrelated section beneath the editor.

### Reordering

Keep pointer drag/reorder.

Also expose keyboard/menu actions:

- Move up
- Move down
- Move to top
- Move to bottom

### Components

- Resizable
- Sheet
- Scroll Area
- Item
- Button Group
- Toggle Group
- Dropdown Menu
- Context Menu
- Tooltip
- Kbd
- Field
- Input Group
- Select
- Switch
- Alert
- Alert Dialog
- Toast

---

## 10.14 Layout library

### Route

`/layouts`

Visual grid.

Each layout:

- preview
- name
- canvas dimensions/aspect
- updated time
- actions

Use real canvas Aspect Ratio.

Creation is a short Dialog.

---

## 10.15 Layout editor

### Route

`/layouts/:id`

Keep custom:

- canvas rendering
- geometry
- selection boxes
- move/resize
- snapping/guides
- preview rendering
- bindings
- draft/autosave
- layout schema compatibility

Everything around the canvas is redesigned.

### Editor layout

```text
← Layouts   Lunch Screen        Saved      100%   Preview   More
----------------------------------------------------------------
Content/Layers |                  Canvas                  | Inspector
```

Use permanent Resizable panels on desktop because this is a true spatial editor.

### Left pane

Tabs:

- Content
- Layers

Content:

- search
- Media/Widget filtering
- compact draggable Item/card previews

Layers:

- compact Items with indentation
- selection
- visibility
- Context Menu
- drag ordering

Do not build a generic Tree component unless the domain truly becomes hierarchical enough to require one.

### Canvas toolbar

Button Group for zoom:

- minus
- current %
- plus
- fit

### Inspector

No Cards for every section.

Use:

- headings
- Separator
- Collapsible

Geometry:

- Input Group
- units shown as addons

Appearance:

- Slider
- color controls
- Select/Combobox
- Toggle Group alignment

Data binding:

- DataSourcePicker

### Keyboard shortcuts

Use Tooltip + Kbd for visible affordance.

Preserve or add keyboard actions where safe:

- delete
- duplicate
- arrow nudge
- shift+arrow larger nudge
- undo/redo if supported

### Native prompt cleanup

All current prompt-based naming/entry flows become Dialog + Field.

---

## 10.16 Campaigns

### Routes

- `/campaigns`
- `/campaigns/:id`

### Library

Operational Data Table:

- Campaign
- State
- Presentation
- Destinations
- release window
- updated
- actions

### Detail/editor

Local panels:

- Overview
- Content
- Destinations
- Release
- Activity

Use Tabs only if those remain local panels.

The Release panel must summarize the outcome in human language before a consequential publish/release action.

Archive/stop actions use Alert Dialog.

---

## 10.17 Schedules

### Routes

- `/schedules`
- `/schedules/new`
- `/schedules/:id`

### Library

Offer:

- List
- Timeline only if the current/custom timeline provides meaningful scheduling insight

Do not create a decorative timeline simply because calendars look attractive.

List = Data Table:

- Name
- Content
- Targets
- Rule
- Next run
- Enabled
- actions

### Editor

Preserve `scheduleBuilderModel`.

Wide-screen layout:

```text
Schedule form                         Summary
```

Summary should turn configuration into human-readable language.

### Date/time

Remember that current shadcn Date Picker is a Popover + Calendar composition.

One-time:

- Date Picker composition
- time Input

Weekly:

- weekday controls
- time Input
- timezone Combobox

### Targets

Use searchable multi-Combobox with chips for large screen/group/location sets.

Do not render huge checkbox walls.

### Components

- Workspace controls
- Data Table
- Toggle Group
- Radio Group
- Checkbox
- Switch
- Combobox
- Calendar
- Popover
- Field
- Input
- Alert
- Alert Dialog
- Toast

---

## 10.18 Content Review

### Routes

- `/content-review`
- `/content-review/submissions`

Keep its distinction from Forms approvals.

Use Data Table for queue.

Columns depend on actual content review data but should communicate:

- content
- type
- author
- submitted/changed
- review state
- release/usage context

Open simple review in Sheet where possible.

Reject flows requiring a reason use Dialog + Textarea.

Approve/reject success uses Toast.

---

## 10.19 Approvals

### Route

`/approvals`

Replace current manual clickable `<tr role="button">` pattern.

Use feature-specific TanStack Data Table:

- Form
- Submission
- Submitter
- State
- Submitted
- Display window

The primary identifier is a real link or explicit row action.

Open submission review in a Sheet if enough data is available without a full route transition.

Actions:

- Approve
- Reject

Reject reason, if supported/required, uses Dialog + Textarea.

---

## 10.20 Activity

### Route

`/activity`

Preserve the strong existing activity model:

- Overview
- Proof of Play
- Incidents
- Content Health
- Screen Events
- Audit Log

Preserve role-dependent visibility.

Preserve URL-backed filter state.

### Header

```text
Activity                                  [Date range] [Export CSV]
```

### Local modes

Because these are one reporting workspace and currently use query state, shadcn Tabs can be appropriate.

### Filters

Primary filters inline:

- Search
- Screen
- Event type

Advanced filters in Popover.

Applied filters should remain visible as compact removable Badges/chips.

### Reports

Overview:
- compact metrics
- charts

Proof of Play:
- Data Table

Incidents:
- Data Table or grouped Item list
- Sheet detail

Content Health:
- table/list depending data shape

Screen Events:
- dense Data Table

Audit:
- dense Data Table

### Components

- Tabs
- Date Picker composition
- Combobox
- Select
- Popover
- Badge
- Chart
- Data Table
- Sheet
- Button
- Empty
- Skeleton

---

## 10.21 Plugins index

### Route

`/plugins`

Keep server-driven plugin catalog behavior.

Use compact Cards because each plugin is a bounded app/feature.

Card:

- icon
- name
- short description
- enabled/configured state
- instance count
- link

Split the current large `PluginsPage.tsx`. The catalog and plugin implementations should not live in one file.

Suggested feature directories:

```text
features/plugins/
  catalog/
  emergency-alerts/
  countdown-bar/
  brand-bug/
  noise-meter/
  dependency-graph/
  forms/
```

---

## 10.22 Emergency Alerts

### Route

`/plugins/emergency-alerts`

Rules Data Table:

- name
- event type(s)
- targets
- priority
- enabled
- last triggered
- actions

Persistent current-alert/warning state uses Alert.

Create/edit can be Dialog only if short enough; otherwise dedicated local editor.

Delete uses Alert Dialog.

---

## 10.23 Countdown Bar

### Routes

- `/plugins/countdown-bar`
- `/plugins/countdown-bar/new`
- `/plugins/countdown-bar/:id`

Instances as Item rows or cards if the server/client provides a useful visual preview.

Editor:

- settings
- live preview

Use:

- Field
- Radio Group
- Switch
- Slider
- Input
- Combobox target picker
- Date Picker composition where relevant

The existing urgency stages should gain a visual explanation/timeline if practical, while preserving the same stored values.

---

## 10.24 Brand Bug / Watermark

### Routes

- `/plugins/brand-bug`
- `/plugins/brand-bug/new`
- `/plugins/brand-bug/:id`

Visual resource cards/list.

Editor:

- preview
- media selector
- position
- opacity
- targets
- schedule if present

Use Toggle Group for fixed position options when the data model maps naturally.

---

## 10.25 Noise Meter

### Routes

- `/plugins/noise-meter`
- `/plugins/noise-meter/new`
- `/plugins/noise-meter/:id`
- `/plugins/noise-meter/:id/history`

Instances = Item list.

Editor:
- source/device settings
- visual meter preview
- thresholds
- targets

History:
- Chart first
- exact readings/events table below

---

## 10.26 Dependency Graph

### Route

`/plugins/dependency-graph`

Keep the graph custom.

Use shadcn only for its chrome:

- search
- type filters
- zoom Button Group
- selected node Sheet
- Empty/error states

Selected node Sheet:

- resource identity
- type
- status
- dependencies
- used-by links
- open resource

Do not replace the graph with Cards or a table.

---

## 10.27 Forms plugin

### Routes

- `/plugins/forms`
- `/plugins/forms/new`
- `/plugins/forms/:id`

### Forms library

Data Table or compact Item list depending current metadata.

### Guided creation

Use Questionnaire for initial form creation:

Possible steps:

1. purpose/template
2. who may submit
3. review requirement
4. display timing policy
5. access

Questionnaire should create the form and then route into the full editor.

Do not use Questionnaire as the editor itself.

---

## 10.28 Form editor

Recommended layout:

```text
Fields            Preview                 Inspector
```

Use Resizable.

Fields:
- Item list
- add/reorder
- Context Menu/Dropdown Menu

Preview:
- actual shadcn Field/Input/Select/etc.
- should closely represent submitter experience

Inspector:
- selected field configuration

Higher-level local panels:

- Form
- Workflow
- Responses
- Access

Responses:
- Data Table
- Sheet detail/review

Keep form Data Source relationships visible for advanced workflows instead of hiding the domain model completely.

---

## 10.29 Forms portal

### Routes

- `/forms`
- `/forms/:id`
- `/forms/:id/new`
- `/forms/:id/submissions/:recordId`

Keep this outside the operator Studio shell.

Small standalone shell:

```text
Tilecast Forms                                       User menu
--------------------------------------------------------------
Forms available to you
```

Use Cards/Items for available forms.

Submission flows use normal shadcn form controls.

Do not show the Studio sidebar.

---

## 10.30 Settings

### Routes

Preserve current `/settings/...` routes and navigation groups.

Current grouping is good and should survive:

#### Organization

- General
- Branding
- Users
- Sign-in security
- Locations

#### Content and playback

- Playback
- Media
- Websites
- Scheduling
- Content review

#### Player management

- Reliability and kiosk
- Active hours and power
- Accessibility control
- Player updates
- Presentation Networks

#### Operations

- Takeovers and commands
- Data retention
- Backup and restore
- Notifications
- Snapshot history
- System
- Integration tokens
- Import and export

### Settings shell

Do not use a second full shadcn Sidebar.

Use a semantic secondary settings `<nav>` in a fixed-width column.

Desktop:

```text
Settings

Organization        General
  General
  Branding          Organization name
  Users             [...]
  ...
```

Mobile:
- settings nav opens in Sheet

### Forms

Replace custom Tilecast Field with shadcn Field.

Use:

- FieldSet
- FieldGroup
- Field
- FieldLabel
- FieldDescription
- FieldError
- Switch
- Select
- Combobox
- Input
- Input Group

Use horizontal Field layouts selectively for compact settings rows.

### Dirty navigation

Replace browser `confirm()` with a controlled unsaved-changes Dialog when moving between Settings sections.

Browser `beforeunload` is still acceptable for full tab/window unload protection where required.

---

## 10.31 Users

### Route

`/settings/users`

Data Table:

- Name
- Role
- scoped access
- MFA/security state
- active/deactivated
- last active if available
- actions

Create/invite:
- Dialog

Edit permissions:
- Dialog or Sheet depending complexity

Reset MFA:
- Alert Dialog with explicit consequences

Deactivate:
- Alert Dialog

Remove native confirms.

---

## 10.32 Backup and Restore

Data Table:

- backup file
- created
- size
- verification/status
- actions

Create backup:
- Button
- Progress/toast.promise if long-running

Restore:
- Alert Dialog
- include destructive consequences
- use typed/name confirmation if warranted by the risk and existing behavior

Delete:
- Alert Dialog

Do not weaken current safety behavior.

---

## 10.33 Notifications

Use:

- notification channel Items
- webhook Data Table
- Dialog for add/edit
- Input Group for generated URLs/secrets/copy controls
- Alert for one-time secret warnings
- Alert Dialog for removal

Input Group should place buttons/addons according to the current Base UI focus guidance; keep the input control first in the DOM when visually moving addons with `align`.

---

## 10.34 Integration Tokens

Data Table:

- Name
- Scopes
- Created
- Last used
- Expiration/status
- actions

Create:
- Dialog

Generated secret:
- one-time Alert
- Input Group + copy button

Revoke:
- Alert Dialog

---

## 10.35 Player Updates

Summary at top:

- current release
- current rollout/deployment state

Data Table for deployments.

Use Progress for active rollout.

Failed screens can open a Sheet.

Actions remain permission-gated.

---

## 10.36 Account

### Route

`/account`

Local sections/tabs:

- Profile
- Appearance
- Sign-in security

Appearance:

- Light
- Dark
- System

Use Radio Group or single-select Toggle Group.

Preserve Tilecast account preference storage/server sync.

Density preference should only affect data-heavy surfaces where it is meaningful. Do not mutate Rhea's global spacing scale.

Security:

- passkeys as Item rows
- authenticators as Item rows
- recovery code actions via Dialog
- Input OTP where enrollment requires a segmented one-time code

---

## 10.37 Login

### Routes

- `/login`
- `/setup` uses related but setup-specific content

Start from `login-03`.

Replace demo branding with Tilecast.

Use:

- Field
- Input
- Button
- Spinner
- Alert

Do not add fake social providers.

---

## 10.38 Initial setup

Use Questionnaire only for genuine organization onboarding questions.

Potential flow:

- organization name
- timezone/region
- initial operational defaults
- authentication choices that are actually supported

Then use dedicated security/MFA enrollment surfaces.

Do not expose every advanced server setting during onboarding.

---

## 10.39 Standalone playlist preview

### Route

`/playlists/:id/preview`

Keep outside Studio shell.

Content should dominate.

Only minimal preview controls:

- Back
- viewport/device mode if supported
- refresh
- close/exit

Do not add sidebar.

---

# 11. Component decision matrix

This matrix is the default decision for the component catalog verified on 2026-09-22.

| Component | Tilecast decision |
|---|---|
| Accordion | Use sparingly for groups of expandable advanced settings |
| Alert | Yes — persistent warnings/errors/system conditions |
| Alert Dialog | Yes — destructive/revoke/reset/archive/restore confirmations |
| Aspect Ratio | Yes — media/layout/playlist/widget previews |
| Attachment | Yes — Media upload queue |
| Avatar | Yes — account and user surfaces |
| Badge | Yes — labeled state/type/status |
| Breadcrumb | Yes — Studio header and folder paths |
| Bubble | No current Studio use; chat-specific |
| Button | Yes — actions |
| Button Group | Yes — grouped editor/actions |
| Calendar | Yes through date/scheduling compositions |
| Card | Yes, but only bounded objects/metrics |
| Carousel | No planned use |
| Chart | Yes — Overview, Activity, Noise Meter |
| Checkbox | Yes — boolean choices and table selection |
| Collapsible | Yes — individual advanced/inspector sections |
| Combobox | Yes — major resource picker primitive |
| Command | Yes — global search/quick actions; keep `cmdk` |
| Context Menu | Yes — convenience actions in editors/media, never sole access |
| Data Table | Yes — feature-specific TanStack v9 tables |
| Date Picker | Yes — as documented Popover + Calendar composition |
| Dialog | Yes — short interrupting create/edit tasks |
| Direction | No immediate surface; keep generated components compatible |
| Drawer | Limited — responsive/mobile dialog/inspector patterns |
| Dropdown Menu | Yes — overflow/action menus |
| Empty | Yes — all real empty resource states |
| Field | Yes — all form composition |
| Hover Card | Optional only for helpful previews; never required interaction |
| Input | Yes |
| Input Group | Yes — search, geometry, units, copyable secrets/URLs |
| Input OTP | Yes where pairing/MFA code format fits |
| Item | Yes — major compact-list primitive |
| Kbd | Yes — command/editor shortcuts |
| Label | Used within canonical Field compositions |
| Marker | No normal Studio use; conversation-oriented |
| Menubar | Not in initial migration; reconsider only if editors truly need File/Edit/View command hierarchy |
| Message | No current Studio use |
| Message Scroller | No current Studio use |
| Native Select | Rare; use only when native behavior is intentionally preferred |
| Navigation Menu | No main Studio use; possible future public/docs nav |
| Pagination | Yes when API/data size requires pages |
| Popover | Yes — small transient filters/options/date/color composition |
| Progress | Yes — uploads, backups, update rollouts |
| Questionnaire | Yes — setup and guided Form creation only |
| Radio Group | Yes — mutually exclusive form choices |
| Resizable | Yes — Layout, Form, Playlist editors |
| Scroll Area | Yes — editor panes and contained secondary nav |
| Select | Yes — short fixed enums |
| Separator | Yes — restrained hierarchy |
| Sheet | Yes — complementary desktop details/inspectors/content picker |
| Sidebar | Yes — `dashboard-01` shell |
| Skeleton | Yes — initial/collection loading |
| Slider | Yes — opacity/thresholds/scales |
| Spinner | Yes — button/pending mutations |
| Switch | Yes — boolean settings |
| Table | Yes — simple tables and TanStack rendering |
| Tabs | Yes — local layered panels, not route facets |
| Textarea | Yes |
| Toast | Yes — transient mutation outcomes |
| Toggle | Yes — one toolbar on/off state |
| Toggle Group | Yes — grid/list, alignment, single mode selection |
| Tooltip | Yes — icon actions and shortcut hints |
| Typography | Use semantic HTML/Tailwind conventions; do not create a Typography wrapper layer |

---

# 12. Custom Tilecast components that are allowed

The redesign must not confuse "use shadcn" with "never write product components."

Custom components are correct when they represent Tilecast concepts.

Examples:

- `MediaAssetCard`
- `PlaylistPreview`
- `LayoutPreview`
- player/live screen preview
- `ScreenContentChain`
- `UsedByPanel`
- `DataSourcePicker`
- layout Canvas
- playlist sequence/timeline
- noise/fleet charts
- dependency graph
- screen status mapping
- target/presentation pickers when they encode substantial domain logic

These should be composed from shadcn primitives where possible.

Do not create custom components that merely rename primitives:

Bad:

- `TilecastButton`
- `TilecastSelect`
- `TilecastDialog`
- `TilecastPopover`
- `Panel`
- `GenericCard`
- `GenericResourceTable`
- `ViewTabs`
- `StatusDot` when Badge + text suffices

---

# 13. Suggested file architecture

Target direction:

```text
apps/dashboard/src/
  components/
    ui/                         # shadcn-owned registry files
    studio/
      AppSidebar.tsx
      SiteHeader.tsx
      CommandPalette.tsx
      WorkspaceNav.tsx
      ResourceHeader.tsx        # only if genuinely repeated
      ThemeProvider.tsx

  features/
    overview/
    screens/
      fleet/
      pairing/
      detail/
      groups/
    media/
      library/
      upload/
      detail/
    widgets/
    data-sources/
      providers/
    playlists/
      library/
      editor/
    layouts/
      library/
      editor/
    campaigns/
    schedules/
    activity/
    reviews/
    approvals/
    plugins/
      catalog/
      emergency-alerts/
      countdown-bar/
      brand-bug/
      noise-meter/
      dependency-graph/
      forms/
    settings/
    account/
    auth/

  api/
  auth/
  navigation/
```

Do not force a wholesale move of every file before the UI changes. Migrate feature boundaries when the relevant surface is being rebuilt.

---

# 14. Current repo logic to preserve

Do not rewrite working domain behavior purely for visual consistency.

Preserve as much as practical:

- `api/client`
- API types/contracts
- React Query keys and behavior
- authentication/CSRF
- role/capability logic
- canonical React Router routes
- `studioRoutes` handles/search metadata
- dynamic breadcrumbs
- `fuzzyScore`
- `playlistEditorModel`
- `scheduleBuilderModel`
- layout geometry and serialization
- layout preview/rendering
- media/player preview logic
- data-source provider behavior
- DataSource compatibility filtering
- multi-source Widget binding behavior
- `DataSourcePicker` workflow semantics
- `UsedByPanel` graph data
- `ScreenContentChain`
- navigation blockers/dirty state protection
- forms permissions/review behavior
- content review
- takeovers/commands
- player updates
- presentation networks
- backups/import/export/integration token security semantics

Server/API changes require a real missing capability, not merely a cleaner component implementation.

---

# 15. Native browser interaction cleanup

Current repository search shows browser `confirm()` usage across many Studio surfaces including Screens, Media, Widgets, Data Sources, Layouts, Campaigns, Schedules, Plugins, Emergency Alerts, Users, Settings, Backups, Notifications, Integration Tokens, Player Policy, source editors, uploads, and playlist editing.

Current repository search also finds `prompt()` in dashboard code including Screens, Schedules, and Layout Editor.

Migration requirement:

- no user-facing `confirm()` remains
- no user-facing `prompt()` remains

Replace:

- destructive choice → Alert Dialog
- discard unsaved state → Dialog
- text/name entry → Dialog + Field
- high-risk restore/reset → Alert Dialog with sufficient contextual confirmation

`beforeunload` browser protection may remain where appropriate for closing/reloading the entire page.

---

# 16. CSS migration

Current post-#523 `main.tsx` imports a large legacy stack including:

- `styles.css`
- `styles/signal.css`
- `styles/topbar.css`
- `styles/topbar-width-fixes.css`
- `styles/reliability.css`
- `styles/screens.css`
- `styles/sync-groups.css`
- `styles/account-menu.css`
- `styles/issue-fixes.css`
- `styles/issues-37-45.css`
- `styles/issues-48-49.css`
- `styles/data-sources.css`
- `styles/forms.css`
- `styles/player-updates.css`
- `styles/context-menu.css`
- `styles/popover.css`
- `styles/screens-media-fixes.css`
- `styles/playlist-editor.css`

These are migration targets.

### Rule

When a surface is rebuilt, delete the obsolete selectors/styles for that surface instead of leaving them as dead compatibility CSS.

### Generic CSS that should disappear

Do not keep legacy global styling for:

- buttons
- cards/panels
- fields
- selects
- dialogs
- popovers
- tables
- sidebars
- tabs
- empty states
- badges
- generic loading indicators

### CSS that may remain

Feature-specific styling is legitimate for:

- layout canvas
- player/presentation rendering
- custom graph layouts
- bespoke preview geometry
- specialized visualization behavior
- rare animation impossible/unreasonable as utilities

Never add a new `issue-fixes.css`-style patch file.

---

# 17. Dependencies

### Keep

- React
- React Router
- TanStack Query
- React Hook Form
- Zod
- Lucide
- `cmdk` — because shadcn Command currently uses it
- QR code package where pairing still needs it

### Add/manage through shadcn or direct documented need

- `@base-ui/react`
- Tailwind CSS 4
- `@tailwindcss/vite`
- `@tanstack/react-table` v9 for complex tables
- Recharts v3 for Chart
- `react-resizable-panels` for Resizable
- dependencies installed by specific registry components/blocks

### Remove after migration if unused

- `@tilecast/design-tokens` from the dashboard
- old custom UI helper dependencies that become unused
- legacy theme/helper code

Before deleting the **design-tokens package itself**, search the entire monorepo for non-dashboard consumers.

Do not remove Lucide; it is intentionally the selected shadcn icon library.

Do not remove cmdk while using shadcn Command.

---

# 18. Theme and appearance

Use the canonical Vite light/dark/system ThemeProvider approach as the basis.

Preserve Tilecast's existing server-backed/user preference behavior, but make the actual DOM theme implementation follow shadcn's class-based light/dark convention.

Requirements:

- Light
- Dark
- System
- no flash where practical
- no parallel legacy `data-theme` design-token system after migration
- custom canvas/player previews may have their own content appearance independent of Studio theme

Official reference:

- https://ui.shadcn.com/docs/dark-mode/vite

---

# 19. Responsive behavior

Studio is desktop/laptop-first, but must not break at narrow widths.

### Shell

Use built-in Sidebar mobile behavior.

### Settings

Secondary nav becomes a Sheet on narrow displays.

### Tables

Allow horizontal scrolling when necessary rather than crushing columns unreadably.

Hide low-priority columns responsively only when the information remains accessible elsewhere.

### Editors

Layout/Form/Playlist:

- desktop → Resizable panes
- narrow → one primary work area plus inspector/content Sheet
- do not shrink three panes into unusable 200px strips

### Dialogs

Long Dialog content must scroll while keeping heading/actions usable.

Use the documented sticky/scrollable composition.

### Drawer

If Drawer is used, include the Base UI iOS body-position requirement.

---

# 20. Accessibility requirements

The redesign should reduce home-grown accessibility mechanics.

Requirements:

- use real links for navigation
- use real buttons for actions
- do not simulate clickable rows with `role="button"` when a link is appropriate
- use Field for labeling/error/description relationships
- icon-only buttons have accessible names
- Tooltip supplements; it never supplies the only essential label
- Context Menu duplicates convenient actions available through another keyboard-accessible path
- statuses are not color-only
- destructive actions use Alert Dialog
- focus returns correctly after dialogs/sheets
- custom drag/drop workflows have keyboard alternatives
- layout/playlist custom selection remains keyboard operable where current behavior supports it
- honor reduced motion
- preserve visible focus
- test dark and forced/high-contrast behavior for custom canvases/statuses

---

# 21. Migration sequence

## Phase 0 — Establish the baseline

Start from clean post-#523 main or cleanly rebase the active work onto it.

Do not continue the abandoned Spectrum implementation.

Actions:

1. record current build/test baseline
2. move legacy `components/ui` to `components/legacy-ui`
3. mechanically update imports
4. add no new legacy UI
5. configure shadcn existing-Vite integration
6. initialize Base UI + Rhea
7. run `shadcn info`
8. add `dashboard-01`
9. add only foundation components required by shell/theme

Exit:
- build/test green
- old UI still functional through `legacy-ui`
- shadcn `components/ui` is cleanly owned

## Phase 1 — Shell

Implement:

- ThemeProvider
- AppSidebar from dashboard-01
- SiteHeader
- Breadcrumbs
- account menu
- notifications
- Command palette
- WorkspaceNav
- Toaster

Preserve auth/routing/query behavior.

Exit:
- every old page can render inside new shell
- sidebar collapses to icons
- mobile shell works
- route active states correct
- Cmd/Ctrl+K works
- no global Create/Pair duplication

## Phase 2 — Hard visual checkpoint

Migrate only:

1. Overview
2. Screens fleet
3. Screen detail

Then stop and review the running product.

This is the decision gate.

Do not migrate the rest until these three feel clearly better than the old system and the abandoned Spectrum version.

Review:

- density
- sidebar proportion
- table readability
- topbar restraint
- light/dark
- 13–14" laptop width
- collapsed sidebar
- screenshot/live preview balance
- empty fleet

## Phase 3 — Content

Migrate:

- Media
- upload
- asset detail
- Widgets
- Widget editor
- DataSourcePicker presentation
- Data Sources
- provider editors
- UsedByPanel

Delete matching old CSS.

## Phase 4 — Presentations

Migrate:

- Playlist library
- Playlist editor
- Layout library
- Layout editor
- Campaigns

Break mega-files while touching them.

## Phase 5 — Scheduling and monitoring

Migrate:

- Schedules
- Activity
- Content Review
- Approvals

## Phase 6 — Plugins

Migrate/split:

- plugin catalog
- Emergency Alerts
- Countdown Bar
- Brand Bug
- Noise Meter
- Dependency Graph
- Forms plugin/editor

## Phase 7 — Administration

Migrate:

- Settings shell/sections
- Users
- account
- security
- backups
- notifications
- tokens
- updates
- import/export

## Phase 8 — External/auth surfaces

Migrate:

- login-03
- setup
- enrollment
- Forms portal
- playlist preview polish

## Phase 9 — Purge

Repository-wide searches:

```text
legacy-ui
components/ui/index
confirm(
window.confirm(
prompt(
window.prompt(
className="button
className="panel
className="field
className="data-table
issue-fixes
signal.css
```

Review each hit.

Delete unused dependencies and CSS.

Run full validation.

---

# 22. Testing strategy

Do not rewrite tests to assert shadcn's internal DOM.

Test behavior and accessible output.

### Shell

- correct active nav
- capability-gated Approvals
- collapsed/expanded state behavior
- account actions
- Command keyboard invocation/search/select
- route breadcrumbs

### Data tables

- sorting/filtering where supported
- selection
- bulk action availability
- pagination
- primary links
- empty/error/loading state

### Dialog/AlertDialog

- focus/close
- destructive action only fires after confirmation
- cancellation leaves data unchanged

### Editors

Preserve model tests.

Add focused UI tests around:

- playlist selection/inheritance
- layout inspector selection
- schedule target/recurrence form
- DataSourcePicker compatibility/connect flow
- dirty-state navigation

### Forms

- Questionnaire creation flow
- editor field selection
- response/review

### Existing suites

Do not delete tests simply because markup changed.

Prefer role/name queries.

---

# 23. Validation

Run repository-standard validation. At minimum verify:

```bash
npm run format:check
npm run lint
npm test
npm run build
```

Use the actual root/workspace scripts if commands differ.

Also run:

```bash
npx shadcn@latest info
```

and confirm the project still reports the intended Base UI/Rhea setup.

### Visual QA matrix

Review at minimum:

- Login
- Setup
- Overview
- Screens Fleet
- Pair Screen
- Screen Detail
- Display Groups
- Media grid/list
- upload
- Widget library/editor
- Data Sources/list/editor
- Playlist library/editor
- Layout library/editor
- Campaigns
- Schedules
- Activity
- Content Review
- Approvals
- Plugins
- each built-in plugin
- Forms editor
- Forms portal
- Settings
- Users
- Account/security

At:

- light
- dark
- normal laptop width
- narrow laptop/split view
- collapsed sidebar
- mobile shell for key non-editor routes

---

# 24. Definition of done

The redesign is complete when all of the following are true:

- shadcn/ui Base UI + Rhea is the Studio design foundation.
- `dashboard-01` composition is the basis of the authenticated shell.
- the sidebar is compact, icon-collapsible, and contains only major workspaces.
- workspace facets are route navigation rather than permanently nested sidebar links.
- `login-03` is the basis of authentication presentation.
- `components/ui` contains shadcn registry code rather than Tilecast's old generic UI system.
- the legacy UI directory is gone.
- the old generic UI CSS/fix stack is gone.
- global Create/Pair action duplication is gone.
- Overview is operationally useful and dense.
- Screens uses a proper feature-specific TanStack Data Table.
- Media is a real visual library.
- Data Sources is an operational table.
- Playlist and Layout editors maximize working space.
- playlist-wide defaults and per-item overrides are clear.
- History is contextual rather than random page content.
- custom layout canvas behavior is preserved.
- Settings retains its good information architecture but uses canonical Fields.
- native `confirm()` and `prompt()` are gone from user-facing Studio code.
- Link semantics are preserved for navigation.
- `cmdk` remains only as the legitimate shadcn Command dependency/use.
- Lucide remains the intentional icon library.
- status never depends on color alone.
- tests/lint/build pass.
- light/dark/system work.
- the app no longer needs page-specific CSS repair files to look coherent.

---

# 25. Anti-regression rules for future development

After this migration:

1. **Check shadcn first.** If the component exists, use it.
2. **Use the current Base UI docs**, not random old shadcn snippets.
3. **Do not create generic UI wrappers** unless they encode actual application behavior.
4. **No new global fix CSS files.**
5. **No generic Panel component.**
6. **Cards represent objects/metrics, not arbitrary sections.**
7. **Actions live near their context.**
8. **Routes use links.**
9. **Tabs are for local panels, not distinct resources/routes.**
10. **Data tables stay feature-specific.**
11. **Context menus are supplemental, not the only path.**
12. **Editor custom UI is allowed when the interaction is truly Tilecast-specific.**
13. **Preserve domain logic before redesigning it.**
14. **Any new design-system exception should be explainable in a code review in one sentence.**
15. **When a recurring UI problem appears, fix the canonical component/composition—not the page with another CSS patch.**

---

# 26. Official references verified for this plan

These references were checked while finalizing the plan on 2026-09-22.

## Core

- shadcn installation: https://ui.shadcn.com/docs/installation
- Vite existing-project setup: https://ui.shadcn.com/docs/installation/vite
- Rhea: https://ui.shadcn.com/docs/changelog/2026-05-rhea
- Base UI default: https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default
- Base UI blocks: https://ui.shadcn.com/docs/changelog/2026-02-blocks
- CLI/info: https://ui.shadcn.com/docs/cli
- Blocks: https://ui.shadcn.com/blocks

## Blocks

- Authentication blocks / login-03: https://ui.shadcn.com/blocks/authentication
- Sidebar blocks / sidebar-03 and sidebar-07: https://ui.shadcn.com/blocks/sidebar
- dashboard-01: https://ui.shadcn.com/blocks

## Major components

- Sidebar: https://ui.shadcn.com/docs/components/base/sidebar
- Command: https://ui.shadcn.com/docs/components/base/command
- Button: https://ui.shadcn.com/docs/components/base/button
- Button Group: https://ui.shadcn.com/docs/components/base/button-group
- Toggle Group: https://ui.shadcn.com/docs/components/base/toggle-group
- Data Table: https://ui.shadcn.com/docs/components/base/data-table
- Table: https://ui.shadcn.com/docs/components/base/table
- Field: https://ui.shadcn.com/docs/components/base/field
- Combobox: https://ui.shadcn.com/docs/components/base/combobox
- Input Group: https://ui.shadcn.com/docs/components/base/input-group
- Input OTP: https://ui.shadcn.com/docs/components/base/input-otp
- Item: https://ui.shadcn.com/docs/components/base/item
- Attachment: https://ui.shadcn.com/docs/components/base/attachment
- Sheet: https://ui.shadcn.com/docs/components/base/sheet
- Drawer: https://ui.shadcn.com/docs/components/base/drawer
- Dialog: https://ui.shadcn.com/docs/components/base/dialog
- Alert Dialog: https://ui.shadcn.com/docs/components/base/alert-dialog
- Tabs: https://ui.shadcn.com/docs/components/base/tabs
- Date Picker: https://ui.shadcn.com/docs/components/base/date-picker
- Chart: https://ui.shadcn.com/docs/components/base/chart
- Resizable: https://ui.shadcn.com/docs/components/base/resizable
- Empty: https://ui.shadcn.com/docs/components/base/empty
- Toast: https://ui.shadcn.com/docs/components/base/toast
- Questionnaire: https://ui.shadcn.com/docs/components/base/questionnaire
- Typeset: https://ui.shadcn.com/docs/typeset

---

# 27. Implementation principle

The purpose of adopting shadcn is **not** to make Tilecast look like a stock shadcn demo.

The purpose is to stop redesigning primitive interactions and spend Tilecast's custom design effort on the places that deserve it:

- showing what is on a screen
- understanding why content is stale
- moving content through Media → Widget → Presentation → Screen
- authoring a playlist
- arranging a layout
- scheduling playback
- reviewing submissions
- operating a fleet

Rhea provides the consistent baseline. Tilecast's workflows and content provide the identity.
