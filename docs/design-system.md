# Tilecast Signal design system

Tilecast Signal is the shared visual language for Tilecast Studio and Tilecast
Player. It is calm, operational, compact, and accessible. It favors clear
hierarchy, borders, readable density, and explicit state over decoration.

This specification is for contributors designing or implementing Tilecast
interfaces. It records what is available today and the rules new work must
follow. It is not a component gallery, a marketing style guide, or permission
to present planned features as complete.

## System boundaries

Signal covers two related but separate interfaces:

| Surface         | Purpose                                        | Implementation source                                                                                              |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Tilecast Studio | Browser-based management interface             | shadcn Base UI Base Vega primitives in `apps/dashboard/src/components/ui`, with Geist and Tailwind theme variables |
| Tilecast Player | Fullscreen Android TV application              | Native Compose theme and components under `org.tilecast.player.ui.theme`                                           |
| Signage content | Organization-authored material shown by Player | Content, layout, and organization-branding settings. it does not redefine Studio                                   |

Studio and Player share Signal's operational character and accessibility
expectations. They do not share a rendering library. CSS is authoritative for
Studio. Compose is authoritative for Player.

Studio's canonical component baseline is shadcn Base UI **Base Vega**, with a
neutral theme, Geist, Lucide, CSS variables, and a small radius. Generated
components are kept aligned with the official Vega registry. The older Signal
tokens remain in use for domain-specific and unmigrated surfaces; do not use
them to restyle canonical shadcn components or the Studio shell.

Organization branding is content identity, not application chrome. An
organization accent or logo may appear in a preview, avatar, or small identity
detail. It never replaces Signal Blue in Studio navigation, actions, selected
states, links, or focus rings.

## Status of guidance

Use these labels when discussing the design system:

| Status            | Meaning                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Implemented**   | Available from shared tokens, React primitives, or the Player theme and safe to use now.                                      |
| **Normative**     | Required behavior for new or changed UI, even if enforcement is partly manual.                                                |
| **Page-specific** | Present in the product but not yet a shared pattern. Reuse its behavior cautiously. do not describe it as a system primitive. |
| **Planned**       | Proposed in the [Signal pattern roadmap](design-system-roadmap.md). It is not available until its status becomes Implemented. |

The roadmap is planning material. This document remains authoritative for
implemented and normative behavior.

## Principles

1. **Make state and action clear.** Show what is happening, what changed, and
   the next safe action without requiring interpretation.
2. **Prefer useful density.** Fit operational information comfortably without
   oversized cards, decorative whitespace, or compressed touch targets.
3. **Use predictable patterns.** Prefer shared controls and familiar layouts to
   page-specific interaction inventions.
4. **Keep identity in its lane.** Tilecast application chrome stays neutral
   and restrained. Organization branding belongs to signage and small identity
   details.
5. **Communicate beyond color.** Pair every status color with text and, where
   useful, an icon or dot.
6. **Preserve focus.** Keyboard and D-pad focus must always be visible, ordered,
   and recoverable.
7. **Show real system truth.** Do not fabricate analytics, storage totals,
   processing progress, compatibility, or feature availability.

Avoid gradients, glass effects, decorative motion, nested cards,
consumer-streaming patterns, hover-only operations, and a different icon for
every field.

## Foundations

### Token architecture

`packages/design-tokens/tokens.css` is Studio's public CSS import. It composes
the token layers in this order:

| Layer      | File             | Responsibility                                                   | Usage rule                                                 |
| ---------- | ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| Primitive  | `colors.css`     | Neutral and chromatic color values                               | Use only while defining semantic or component tokens.      |
| Semantic   | `semantic.css`   | Canvas, surface, text, border, action, focus, and status meaning | Default choice for page and component styling.             |
| Typography | `typography.css` | Font families and text roles                                     | Use roles instead of recreating font shorthand values.     |
| Scale      | `spacing.css`    | Spacing, radii, and motion timing                                | Keep new work on the shared scale.                         |
| Component  | `components.css` | Sidebar, input, table, notice, and related roles                 | Use when the meaning is specific to that component family. |

Compatibility aliases such as `--tc-ink`, `--tc-surface`, and `--tc-brand`
exist while older page CSS moves to semantic names. New work uses the
`--tc-text-*`, `--tc-bg-*`, `--tc-action-*`, `--tc-border-*`, and
`--tc-status-*` families.

Raw color values belong only in token definitions, the native Player theme, or
dynamic previews of organization-controlled values. A page must not copy a hex
value from this document.

### Color

Signal Blue is the fixed interface action color. Broadcast Amber is a Tilecast
identity color used in the tall logo tile and restrained brand details. It is
not a warning color. Success, warning, danger, information, and neutral each
have separate foreground, background, and border roles.

#### Core identity and surfaces

| Role             | Light value | Dark value | Use                                                   |
| ---------------- | ----------- | ---------- | ----------------------------------------------------- |
| Canvas           | `#F6F8FA`   | `#0E141B`  | Application background                                |
| Surface          | `#FFFFFF`   | `#151D26`  | Panels and controls                                   |
| Subtle surface   | `#EEF2F5`   | `#202C38`  | Secondary grouping and table headers                  |
| Elevated surface | `#FFFFFF`   | `#1B2632`  | Menus, dialogs, and overlays                          |
| Primary text     | `#17212B`   | `#F5F7FA`  | Main copy and labels                                  |
| Secondary text   | `#667582`   | `#9EADB9`  | Supporting and metadata copy                          |
| Primary action   | `#3E6FE0`   | `#3E6FE0`  | Actions, links, selection, and focus-related emphasis |
| Broadcast Amber  | `#E9B44C`   | `#F4C15A`  | Tilecast identity only                                |

Values are references for review. Consume their semantic token, not the literal
value.

#### Studio control roles

Control colors are theme-scoped. Legacy Signal surfaces consume the aliases in
`components.css`. They must not assume the dark palette is the default.

shadcn components never read these roles; they read the Base Vega tokens
(`--background`, `--accent`, `--border`, `--input`, `--ring`, and the rest)
defined in `apps/dashboard/src/styles.css`. The legacy roles therefore carry
the `--tc-` prefix. An unprefixed legacy token with a shadcn name would win
over the Vega value, because the legacy theme selectors are more specific, and
would recolor every generated component.

| Token                    | Light value                | Dark value                 | Use                                     |
| ------------------------ | -------------------------- | -------------------------- | --------------------------------------- |
| `--tc-accent`            | `#3E6FE0`                  | `#3E6FE0`                  | Primary actions, links, selected states |
| `--tc-accent-hover`      | `#4D7CE6`                  | `#4D7CE6`                  | Primary hover                           |
| `--tc-accent-active`     | `#3563CF`                  | `#3563CF`                  | Primary pressed state                   |
| `--control-border`       | `#D4DCE8`                  | `#2A3D5C`                  | Secondary control border                |
| `--control-label`        | `#3D4C66`                  | `#C6D4EA`                  | Secondary control label                 |
| `--control-hover-bg`     | `#EEF2F8`                  | `#16223A`                  | Secondary hover fill                    |
| `--field-bg`             | `#FFFFFF`                  | `#111D31`                  | Input and search background             |
| `--field-border`         | `#D4DCE8`                  | `#24344E`                  | Input and search border                 |
| `--field-text`           | `#1A2333`                  | `#F5F7FA`                  | Input and select values                 |
| `--field-placeholder`    | `#8494AB`                  | `#66799A`                  | Placeholder text                        |
| `--chip-bg`              | `#EEF2F8`                  | `#1A2942`                  | Nested keycap and chip background       |
| `--chip-border`          | `#D4DCE8`                  | `#2A3D5C`                  | Nested keycap and chip border           |
| `--chip-text`            | `#61718C`                  | `#7F93B3`                  | Nested keycap and chip text             |
| `--divider`              | `#E5EAF2`                  | `#2C3947`                  | Hairlines and utility-header dividers   |
| `--tc-accent-focus-ring` | 25% alpha of `--tc-accent` | 25% alpha of `--tc-accent` | Three-pixel keyboard-focus outer ring   |

The Studio sidebar deliberately uses the same dark navigation tokens in light
and dark appearances. This is an explicit contrast treatment, not inheritance
from the dark control palette, and may be revisited independently.

#### Status roles

| Tone        | Meaning                                          | Typical examples                                      | Never use for                     |
| ----------- | ------------------------------------------------ | ----------------------------------------------------- | --------------------------------- |
| Success     | Completed, verified, healthy                     | Online, uploaded, saved                               | General positive decoration       |
| Information | Neutral guidance or active information           | Setup guidance, available detail                      | Primary actions                   |
| Warning     | Attention is needed but continuation may be safe | Stale data, partial compatibility                     | Broadcast Amber identity          |
| Danger      | Failure, revocation, or destructive consequence  | Failed processing, revoked player, validation failure | Routine cancellation              |
| Neutral     | Inactive, unknown, queued, or non-urgent         | Offline, pending, not configured                      | Disabled text without another cue |

Status assignments follow domain meaning. Do not infer a tone from an internal
enum name, and do not move server-owned screen status thresholds into Studio or
Player presentation code.

#### Data visualization fills

Status roles are text and background roles. A `--tc-status-*` foreground value
placed behind a chart segment, bar, or swatch is a role mismatch: it is tuned
for contrast against a surface at text weight, not for a saturated fill a few
pixels tall. Measured graphics use the visualization family instead.

| Token               | Meaning                                   |
| ------------------- | ----------------------------------------- |
| `--tc-viz-up`       | Connected and playing                     |
| `--tc-viz-impaired` | Reporting but degraded                    |
| `--tc-viz-down`     | Not reporting                             |
| `--tc-viz-unknown`  | Not measured, with no claim either way    |
| `--tc-viz-track`    | The unfilled remainder of a bar or column |

The family is theme-scoped: dark themes lift the up and impaired fills to the
400 ramp, because the 700 ramp muddies against the dark canvas at segment size.
Fills carry no meaning on their own. Pair every series with a legend, a label,
or an accessible name, per principle 5.

### Typography

Studio uses Geist. Technical values use the shared monospace family. Player
uses the platform sans-serif family at TV scale.

#### Studio roles

| Role          | Token                     | Size / line height         | Use                                                |
| ------------- | ------------------------- | -------------------------- | -------------------------------------------------- |
| Page title    | `--tc-text-page-title`    | 24 / 30 px, semibold       | One title for the current route                    |
| Section title | `--tc-text-section-title` | 18 / 23.4 px, semibold     | Major section within a page                        |
| Panel title   | `--tc-text-panel-title`   | 15 / 20.25 px, semibold    | Bordered group or compact region                   |
| Body          | `--tc-text-body`          | 14 / 21 px                 | Default UI copy                                    |
| Label         | `--tc-text-label`         | 13 / 17.55 px, semibold    | Controls and compact headings                      |
| Supporting    | `--tc-text-supporting`    | 12 / 17.4 px               | Hints, metadata, and secondary context             |
| Technical     | `--tc-text-technical`     | 13 / 18.85 px, medium mono | IDs, versions, hashes, and machine-oriented values |
| Metric value  | `--tc-text-metric-value`  | 24 / 26.4 px, semibold     | The single number in a summary tile                |
| Metric label  | `--tc-text-metric-label`  | 13 / 17.55 px, medium      | What that number counts                            |
| Metric delta  | `--tc-text-metric-delta`  | 12 / 15.6 px, semibold     | Change against a stated comparison period          |

Metric roles are for a tile whose whole purpose is one figure. They are not a
license to enlarge arbitrary numbers inside body copy or tables. A delta is only
honest next to a stated comparison period, so do not render one without saying
what it is compared against.

Use tabular numerals for counts, timestamps, durations, storage, versions, and
percentages when values align or update in place. Do not reduce essential
information to supporting text merely to make a layout fit.

#### Player roles

| Compose role     | Size / line height   | Typical use                       |
| ---------------- | -------------------- | --------------------------------- |
| `displayLarge`   | 52 / 60 sp           | Dominant pairing or state message |
| `headlineLarge`  | 40 / 48 sp           | Primary screen heading            |
| `headlineMedium` | 32 / 40 sp           | Secondary state heading           |
| `titleLarge`     | 24 / 32 sp           | Panel or step title               |
| `bodyLarge`      | 20 / 29 sp           | Main instructions                 |
| `bodyMedium`     | 17 / 25 sp           | Supporting detail                 |
| `labelLarge`     | 18 / 24 sp, semibold | Remote actions                    |

Player copy must remain legible at viewing distance. Do not transfer Studio's
compact type sizes to TV.

### Spacing, radius, and elevation

| Token           | Value | Common use                     |
| --------------- | ----- | ------------------------------ |
| `--tc-space-1`  | 4 px  | Tight internal separation      |
| `--tc-space-2`  | 8 px  | Icon-to-label and compact gaps |
| `--tc-space-3`  | 12 px | Control groups                 |
| `--tc-space-4`  | 16 px | Standard component padding     |
| `--tc-space-6`  | 24 px | Sections and page grids        |
| `--tc-space-8`  | 32 px | Major page separation          |
| `--tc-space-12` | 48 px | Large structural separation    |
| `--tc-space-16` | 64 px | Rare outer or TV spacing       |

| Control token         | Value | Use                          |
| --------------------- | ----- | ---------------------------- |
| `--control-height`    | 36 px | Standard buttons and fields  |
| `--control-height-sm` | 30 px | Compact controls             |
| `--control-height-lg` | 42 px | Explicit large controls      |
| `--control-radius`    | 8 px  | Buttons, inputs, and selects |
| `--chip-radius`       | 5 px  | Nested chips and keycaps     |

New Studio controls use the radius scale generated by shadcn Base Vega from the
small-radius preset (`--radius: 0.45rem`). Do not add larger one-off radii or
pills to shell and navigation components. The `--tc-*` radius values above are
retained for domain-specific and unmigrated surfaces while they move to the
shared primitives. Normal panels use borders. Shadows are reserved for
overlays and drag states. Do not nest bordered panels when spacing, a heading,
or a divider can express the relationship.

Player reuses the 4–48 dp spacing rhythm, adds 72 dp horizontal and 52 dp
vertical screen insets, and keeps remote controls at least 52 dp high.

### Motion

| Token                  | Duration | Use                                    |
| ---------------------- | -------- | -------------------------------------- |
| `--tc-motion-fast`     | 120 ms   | Small hover or focus response          |
| `--tc-motion-standard` | 180 ms   | Normal state transition                |
| `--tc-motion-slow`     | 240 ms   | Larger but still restrained transition |

Motion explains a state change. It does not decorate idle UI. Honor the system
`prefers-reduced-motion` setting and the user's reduced-motion preference.
Loading indicators may rotate, but their accessible label must describe the
work rather than the animation.

### Themes and density

Studio supports light, dark, and system appearance through semantic tokens.
Components are not duplicated by theme. System appearance follows
`prefers-color-scheme`. Explicit light or dark settings take precedence.

Studio also supports comfortable and compact density. Compact density reduces
selected layout spacing, not type legibility, control semantics, focus
visibility, or minimum practical targets. Density is a per-user preference and
must not alter stored domain data.

Whenever tokens or shared components change, verify inputs, notices, statuses,
tables, dialogs, disabled states, and focus rings in light and dark themes.

### Responsive layout

Signal does not currently expose shared breakpoint tokens. Existing pages use
content-driven, page-specific breakpoints. This is **Page-specific**, not a
license to copy arbitrary breakpoint values.

New work must:

- preserve the primary task without horizontal page scrolling.
- let tables scroll within a labeled or clear container when columns cannot
  collapse safely.
- stack actions and field rows before labels or controls become cramped.
- keep important actions visible rather than hover-only.
- preserve document order, focus order, and readable line lengths, and
- provide a deliberate narrow-screen alternative for desktop editing surfaces.

## Studio components

Shared React primitives live in `apps/dashboard/src/components/ui`. Use them
before writing equivalent markup in a page. Their public props and rendered
semantics remain the source of truth.

### Component inventory

| Primitive                  | Implemented variants or behavior                                                             | Use                                                |
| -------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Button`                   | Primary, secondary, quiet, danger. compact and loading states                                | Labeled actions                                    |
| `IconButton`               | Required accessible label and title                                                          | Compact familiar action with no visible label      |
| `Input`, `Textarea`        | Native form semantics                                                                        | Text and multiline entry                           |
| `Select`                   | Signal Select with keyboard menu and hidden native value control                             | Choosing one option from a closed set              |
| `Field`                    | Label, description, required indicator, error                                                | Form control grouping                              |
| `Checkbox`                 | Native checkbox with visible label                                                           | Independent boolean choice                         |
| `Switch`                   | Native checkbox with switch semantics and optional description                               | Immediate on/off setting                           |
| `RadioGroup`               | Fieldset and legend                                                                          | One choice from a small visible set                |
| `Panel`                    | Semantic section wrapper                                                                     | One genuinely separate concept                     |
| `SectionHeader`            | Title, description, actions                                                                  | Page section introduction                          |
| `PageHeader`               | Title, description, eyebrow, and actions                                                     | Consistent route and editor heading                |
| `Toolbar`                  | Toolbar role                                                                                 | Related high-frequency controls                    |
| `ViewTabs`                 | Current-view navigation, markers, Arrow/Home/End focus                                       | Switching route-backed or page-owned views         |
| `Pagination`               | Previous/next controls with optional status                                                  | Server- or cursor-paginated collections            |
| `ViewToggle`               | Grid/list selection                                                                          | Collection presentation choice                     |
| `ToggleGroup`              | One active option in a compact visible group                                                 | Short filters and display modes                    |
| `Notice`                   | Information, success, warning, danger, neutral                                               | Contextual feedback with optional title and action |
| `StatusDot`, `StatusBadge` | Success, information, warning, danger, neutral                                               | Compact textual status                             |
| `EmptyState`               | Title, message, optional action                                                              | Valid collection or workspace with no content      |
| `Dialog`                   | Native modal dialog, title, close action, cancel handling                                    | Focused modal task                                 |
| `Drawer`                   | Modal detail surface, focus containment, responsive full width                               | Browsing or editing contextual detail              |
| `Popover`                  | Anchored surface with menu and form modes, collision-aware placement, one dismissal contract | Trigger-opened menu or compact filter panel        |
| `ContextMenu`              | Right-click and trigger-opened actions, single-level submenus, Arrow/Home/End/Escape         | Row and card actions                               |
| `TableContainer`           | Contained overflow                                                                           | Responsive data table boundary                     |
| `Skeleton`                 | Decorative loading placeholder                                                               | Preserve approximate layout while loading          |
| `Spinner`                  | Labeled status                                                                               | Indeterminate work                                 |
| `MetricTile`               | Value, label, optional icon, hint, delta, and drill-through link                             | One measured figure in a summary row               |
| `FilterBar`, `FilterChips` | Declarative filter definitions with removable active chips                                   | Narrowing a reported collection                    |
| `TimeRangePicker`          | Presets, custom bounds, and a resolved comparison window                                     | Choosing the period a report covers                |

ARIA tab panels, drop zones, inspectors, timelines, and editor shells currently
have page-specific implementations. Their proposed shared forms are Planned, not
Implemented. `ViewTabs` is navigation between page-owned views. It does not claim
ARIA `tab` or `tabpanel` semantics.

#### Anchored surfaces

`Popover` owns everything an anchored surface needs to behave the same way twice.
It measures placement against the viewport and folds the panel back on screen
near an edge. It dismisses on an outside pointer press, on Escape, on a scroll
that moves the trigger, and on a route change. It also sets the trigger's
`aria-expanded`, `aria-haspopup`, and `aria-controls`. Escape always returns
focus to the trigger.

Its two modes are separate contracts. Do not blur them:

| Mode   | Surface role        | Contents               | Focus on open | Tab                     | Arrow keys            |
| ------ | ------------------- | ---------------------- | ------------- | ----------------------- | --------------------- |
| `menu` | `menu`              | Menu items only        | First item    | Closes, restores focus  | Move between items    |
| `form` | `dialog`, non-modal | Labelled form controls | First control | Cycles within the panel | Belong to the control |

Choose `form` when the panel holds anything a menu must not contain. A heading,
static text, group labels, and fields are all such content. An ARIA `menu` drops
that content. The notification panel previously announced as a bare item count,
because its heading and priority-group labels were illegal inside the role it
claimed. Tab cycles inside a form popover instead of leaving it, because the
panel is portaled and is not next in document order after its trigger.

A panel is portaled through `overlayPortalTarget`. This lets it escape clipping
ancestors and share the top layer with a modal dialog that opened it. The panel
sits at z-index 3100, which is above the drawer layer and below the select and
context menus. A `Select` opened inside a popover therefore paints on top, and a
press on one of its options does not dismiss the panel below it.

The shared row and padding treatments in `styles/popover.css` are published
inside `:where()`. They carry no specificity, so a consumer restyles rows with a
plain class instead of out-specifying the shared layer.

#### Reporting primitives

These primitives exist to keep a number honest, not merely to display it. Each
rule below is here because a plainer treatment misled.

A `MetricTile` states one figure. Its delta requires a `comparisonLabel`,
because a change with no stated period is not interpretable, and it takes a
`direction` so a rise is toned by whether rising is good news rather than by its
sign. A metric with no better or worse direction reports movement without a
success or danger tone. Give a tile a `to` when the number has records behind
it: a count a person cannot open is a dead end.

The `hint` is not decoration. It carries the measurement's scope. A tile
without one invites the reader to assume the selected date range applies, so say
"Right now, not over the range" wherever that is true.

**Absent data reads as absent.** A metric with no data shows "No data", never
zero. Zero is a measurement: a compliance figure of 0% claims every expected
play was missed, when in fact none was expected. The same applies to a mean time
to recover with nothing to average.

**Overlapping and partitioning counts are separated visually.** The fleet-health
row places Online apart from the four states beside it, with a rule between,
because Online overlaps the others while healthy, impaired, offline and
unmeasured partition the fleet. Five identical tiles in a row would imply five
comparable slices.

**A drill-down must select exactly what the number counted.** Build every link
through the Activity link helper so the reader's date range and applicable
filters survive, and so a filter the destination cannot apply is dropped rather
than carried. A link that opens a differently-filtered report is worse than no
link, because it silently contradicts the figure just read.

**Excluded quantities stay visible.** Where a metric deliberately removes
something from its denominator. Emergency-overridden or intentionally stopped
playback. List those amounts beside it. Silently improving a percentage makes
it unexplainable.

**Severity lives on a rail, not only in color.** Timeline rows carry severity
as a left border alongside their badge text, so a failure is findable while
scrolling and legible without color vision.

**Status language distinguishes ongoing from finished.** An incident still
failing reads "Ongoing for 40m". One that recovered reads "Lasted 40m".
Recovered items are grouped apart from failing ones and never described as
still failing.

Long-format reporting tables use a header row on the same grid and collapse to
two columns on narrow viewports. Prefer a table over a chart when the reader
needs an exact figure, which in operational reporting is most of the time.
Uptime strips remain the only chart-like primitive in Studio: the reporting
added since has been built from tiles, tables and timelines rather than plotted
series, so there is no chart palette to define yet. Specify one here before
writing it.

A `FilterBar` renders from filter definitions rather than hand-placed controls,
and reflects every active filter except the search field as a removable chip, so
a narrowed result set never reads as an empty one. Filter state belongs in the
URL through `useUrlFilters`, which leaves parameters it does not own untouched.
a filtered report that cannot be reloaded or shared is not finished.

`resolveTimeRange` returns the selected bounds together with the equally long
window immediately before them. It returns no comparison window for a custom
range missing a bound, where the length to step back by would be arbitrary.

### Primary navigation

The inset Studio sidebar uses static groups: Screens (Fleet, Display Groups,
Archive), Content (Media, Widgets, Data Sources), Presentations (Playlists,
Layouts, Campaigns), and Operations (Schedules, Plugins). Group labels are not
routes or controls. Every destination is a real link and remains visible while
the sidebar is open. Overview stays above the groups; Activity, capability-
gated Approvals, and Settings sit at the bottom of SidebarContent. NavUser
alone occupies SidebarFooter. The desktop sidebar hides off-canvas and mobile
uses the Sidebar Sheet behavior. Do not add category disclosure state or
duplicate these route links with workspace bars on the same pages. Same-resource
tabs, such as Screen detail views, remain distinct.

### Persistent Studio header

Authenticated Studio routes use one persistent 56px utility header above page
content. It contains three stable regions:

- The left region renders breadcrumbs from the route hierarchy. A top-level
  route shows one semibold current-page label; a single breadcrumb is not an
  empty state. Detail routes link muted ancestors and render the entity name
  as the unlinked current page. Breadcrumbs come only from route `handle`
  entries in `App.tsx`: every authenticated Studio route declares a
  `breadcrumb`, and a detail route that names an entity declares a `resource`
  so the header can resolve the name. Pages never render their own
  breadcrumbs. Page headings remain `h1` elements. Breadcrumbs are navigation,
  not headings.
- The center region opens global search with `Command+K` on Apple platforms or
  `Control+K` elsewhere. The implemented search providers cover Studio route
  destinations, settings sections, and screen names. Additional entity
  providers may extend this registry without changing the palette interaction.
- The right region contains active-alert notifications. Screen alerts link to
  screen details. Failed Player update deployments link to Player update
  settings. Page-level actions such as Pair screen and Create belong to each
  page header, not the persistent header.

The header is composed from the generated Breadcrumb, Button, Kbd, Popover, and
Item components. Every icon-only control requires an accessible name. The palette supports arrow-key selection, Enter
to navigate, and Escape to close. The global shortcut must not override text
entry inside a dialog.

### Buttons and actions

Use one primary action per local decision area. Secondary actions are bordered
alternatives. Quiet actions reduce visual weight. Danger actions communicate a
destructive consequence. Icon buttons are reserved for familiar actions where
space is constrained and always require an accessible label.

Default buttons are 36 px high and compact (`sm`) buttons are 32 px high. Loading
preserves the label's width, exposes busy state, and disables repeat activation.
Disabled controls use a not-allowed cursor, but a disabled state must not be the
only explanation of why an action is unavailable.

Primary buttons use the Vega `primary` fill and `primary-foreground` text.
Outline buttons use the Vega border on the background surface, and ghost
buttons change only to the `accent` fill on hover. Links that act as buttons
use `buttonVariants` rather than hand-copied classes. Underlines belong to inline
text links, never button labels. Use at most one primary action per decision
region.

A destructive action remains visually restrained until the final confirmation.
The confirmation names the object and consequence. “Cancel” is not destructive
and does not receive danger styling.

### Forms and selection

Labels sit above controls. Supporting text follows the label. Validation follows
the control. Required state must be available to assistive technology, not only
shown as an asterisk. Errors identify the problem and, when known, how to fix
it.

Controls are the generated Base Vega components. Their height, radius, surface,
border, placeholder, disabled treatment, focus ring, and dark-mode fill come
from the component itself. Global element selectors such as `input`, `select`,
or `textarea` must not style them: unlayered CSS outranks Tailwind utilities
and silently replaces the Vega treatment. Use the control that matches the
data:

- checkbox for an independent choice.
- switch for an immediate enabled/disabled setting.
- radio group or toggle group for a small set whose alternatives should
  remain visible.
- Select for a longer closed set, and
- text input only when free entry is genuinely allowed.

Compose Select canonically. Pass the options to `items` on `Select` and render
a bare `<SelectValue />`. Without `items`, `SelectValue` shows the raw value,
such as an ID. Do not render the selected label yourself.

List and filter toolbars follow the same rules everywhere:

- Search uses `DashboardSearch`: an `InputGroup` with a leading search icon
  and, when there is text, a clear `InputGroupButton` in an inline-end addon.
- Each `SelectTrigger` gets an intentional width at the call site, sized to
  its longest option, because the popup takes the trigger's width. Use
  `max-sm:flex-1` so filters share a row evenly on phones. Never widen the
  generated Select globally for one toolbar.
- Controls in one toolbar share the default 36 px height. Do not mix `sm`
  controls into a default-height row.
- Grid and list view switches are outline toggle groups with `spacing={0}`.
- The toolbar itself wraps with flex utilities and needs no page CSS.

Settings translate bytes, durations, weekdays, enums, colors, and Android
package lists at the UI boundary without changing stored values.

### Status and feedback

Every status includes readable text. Use `StatusDot` for dense table or metadata
rows and `StatusBadge` when the state benefits from a contained label. Translate
raw internal values into user-facing language.

Use a Notice for feedback that belongs in the current context. Danger notices
use alert semantics. Non-urgent variants use polite status semantics. Do not use
a warning notice as a permanent decorative panel.

Use an Empty State only when loading has completed successfully and the result
is genuinely empty. Loading, permission denial, network failure, and processing
failure are separate states. Skeletons preserve structure. Spinners represent
indeterminate work. Neither replaces explanatory text when a wait may be long.

### Panels, tables, and dialogs

Panels group genuinely separate concepts. Within a panel, use spacing, headings,
rows, and dividers instead of one card per field.

Tables have no vertical rules, use a subtle header, keep rows approximately
44–52 px high, and contain their own horizontal overflow. Selected rows use the
soft action color. Row actions remain visually secondary and keyboard
accessible. A table must retain meaningful headers and must not become an
unlabeled grid of values on narrow screens.

Borders have three weights and they are not interchangeable. `--tc-border-default`
outlines a panel, a control, or a table against the page. `--tc-border-subtle`
divides rows and regions _inside_ a container that already carries a default
border, so a list does not read as a stack of boxes. `--tc-border-strong` marks
a deliberate emphasis such as a selected boundary. Because the subtle weight is
derived from the theme's own border and surface, it needs no per-theme copy.

Dialogs are for bounded tasks that require attention before returning to the
page. Give each dialog a specific title, a visible close action, Escape/cancel
behavior, and an unambiguous primary action. Do not layer dialogs. Large detail
browsing and persistent inspectors remain page-specific patterns until the
roadmap standardizes them.

A dialog is a native modal `<dialog>`, which the browser paints in the **top
layer**: above every z-index in the document, with the rest of the page inert.
Floating content opened from inside one — a `Select` menu, a context menu — must
therefore portal into the dialog rather than into `<body>`, or it renders behind
the dialog and cannot be clicked at all. `overlayPortalTarget` in
`components/ui/overlayPortal.ts` resolves that target, and `fixedPositionOffset`
beside it corrects `position: fixed` coordinates for a host that is itself the
containing block for fixed children. Two consequences worth remembering: raising
a z-index can never lift something above a modal dialog, and an overlay
animation must not leave a filled `transform` behind (use `backwards`, not
`both`) — a lingering identity matrix silently makes the element a containing
block.

### Icons and logos

Icons clarify familiar actions and states. They do not replace necessary text.
Use the existing Lucide icon vocabulary in Studio. Keep stroke weight and size
consistent within a control group. Do not assign a unique icon to every field or
use an unlabeled icon for an unfamiliar operation.

The Tilecast mark retains its three-tile proportions:

- tall left tile: Broadcast Amber.
- upper-right tile: Signal Blue, and
- lower-right tile: pale blue-gray.

Use the dark wordmark on light surfaces and the white wordmark on dark surfaces.
Do not redraw, distort, or recolor the mark per page.

## Player interface

Player is a fullscreen appliance interface, not a television version of
Studio. Its theme is dark, high-contrast, and intentionally small in scope.
Dynamic Material colors are disabled so device or launcher preferences cannot
change operational meaning.

Player supplies dark navy surfaces, TV typography, shared dimensions, logo
colors, and focus-aware filled and outlined buttons. Every remote action must:

- be reachable in a logical D-pad sequence.
- show a strong Signal Blue focus outline.
- retain at least a 52 dp control height.
- provide a small scale cue that remains stable at viewing distance, and
- remain operable without touch, mouse, or color perception.

Motion is restrained and state-driven. Focus must not cause surrounding layout
to jump. Normal Player UI never displays raw exceptions, internal IDs, debug
JSON, credentials, or development placeholders.

Organization-controlled Player background, text, logo, fallback messages, and
footer use validated settings with safe Tilecast defaults. Organization colors
must not weaken emergency readability, remote focus, or system-state contrast.

## Content and language

Tilecast speaks plainly and operationally. Prefer short sentences, concrete
nouns, active verbs, and the terminology already used by the product.

| Context                 | Rule                                                          | Example                                        |
| ----------------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| Page and section titles | Name the object or task. use sentence case                    | “Player updates”                               |
| Buttons                 | Start with a specific verb. name the result when useful       | “Pair screen”, “Save changes”                  |
| Labels                  | Name the value, not an instruction to the user                | “Server address”                               |
| Supporting text         | Explain consequence, format, or scope                         | “Applies after the player reconnects.”         |
| Status                  | Translate internal state into concise human language          | “Waiting” instead of `queued`                  |
| Error                   | State what failed and the next useful action                  | “Upload failed. Check the file and try again.” |
| Confirmation            | Name the affected object and irreversible consequence         | “Revoke Lobby display credential?”             |
| Empty state             | Explain why the area is empty and offer the next valid action | “No screens are paired.”                       |
| Loading                 | Name the object or operation                                  | “Loading player status…”                       |

Do not use “Are you sure?” without naming the consequence. Avoid “successfully”
when the completed action is already clear. Do not blame the user, expose stack
traces, or turn a server error code into visible copy.

Format dates and times with the user's locale and include timezone context when
the schedule or event can be ambiguous. Present durations and storage in human
units while preserving exact values where operationally useful. Versions and
technical identifiers use technical typography. Secrets, full credentials,
poll tokens, and enrollment tokens must never appear in UI copy, examples,
screenshots, or logs.

## Accessibility

WCAG AA is the minimum contrast target for normal text and controls. In
addition:

- keep keyboard and D-pad focus visible at all times.
- preserve logical document, reading, and focus order.
- associate labels, descriptions, validation, and switch state semantically.
- pair status color with text and an icon or dot.
- honor reduced-motion preferences.
- keep Studio touch targets near 44 px and Player controls at least 52 dp high.
- supply accessible names for icon-only controls.
- announce urgent errors assertively and routine updates politely.
- avoid organization colors where they could weaken Studio or emergency
  readability, and
- verify zoom, narrow screens, text expansion, and contained overflow.

Accessibility behavior is part of a component's contract, not a final review
step.

## Contributor checklists

### New or changed Studio UI

- [ ] Uses semantic or component tokens instead of raw values.
- [ ] Uses shared React primitives where an implemented primitive exists.
- [ ] Does not describe a Planned or Page-specific pattern as shared.
- [ ] Shows loading, empty, error, disabled, and success states that can actually
      occur.
- [ ] Keeps the primary action clear and destructive consequences explicit.
- [ ] Works in light, dark, and system appearance.
- [ ] Works in comfortable and compact density.
- [ ] Preserves keyboard access, visible focus, labels, and announcements.
- [ ] Adapts deliberately to narrow screens and contains table overflow.
- [ ] Respects reduced motion and avoids hover-only operations.
- [ ] Uses real product state and does not fabricate future capability.

### New or changed Player UI

- [ ] Uses the native Signal theme rather than copied Studio CSS values.
- [ ] Works entirely with D-pad focus and remote activation.
- [ ] Keeps controls at least 52 dp high with a visible focus outline.
- [ ] Remains legible at TV viewing distance and does not use Studio-scale type.
- [ ] Preserves state-machine truth and does not expose raw diagnostics or
      credentials.
- [ ] Uses organization branding only through validated Player settings.
- [ ] Has a safe narrow/overscan layout and restrained state-driven motion.
- [ ] Is verified on the supported emulator or device when behavior depends on
      focus, launcher, WebView, or platform rendering.

### Review before merging

- [ ] Token, component, and terminology claims match their source files.
- [ ] Status meaning is not encoded by color alone.
- [ ] Automated formatting, lint, and relevant tests pass.
- [ ] Visual review covers themes, density, responsive layout, and focus.
- [ ] Documentation is updated with the implementation and does not promise
      unfinished work.

## Correct and incorrect use

**Correct:** a white or navy bordered panel with one section heading, compact
rows, a blue primary action, an inline textual status, and a clear narrow-screen
layout.

**Incorrect:** one rounded card per field, a gradient header, amber warnings,
organization-colored focus rings, unlabeled icon actions, fabricated metrics,
or a subtle TV focus state that disappears at viewing distance.
