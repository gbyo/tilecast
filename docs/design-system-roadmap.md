# Tilecast Studio pattern roadmap

This roadmap is a historical planning snapshot for repeated Tilecast Studio UI
patterns. Several statuses, examples, and proposed component contracts predate
the move to shadcn Base UI Base Vega and are no longer a current implementation
inventory. Use the [current Studio and Player design system](design-system.md)
and the code under `apps/dashboard/src/components/ui` for current guidance.

The roadmap records the intent and rationale of the earlier component work. Do
not treat its historical **Implemented** status or behavior descriptions as a
current registry contract without checking the current code and official Base
Vega documentation.

## Status model

| Status                       | Meaning                                                     | Exit condition                                                                         |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Candidate**                | Repeated need with a proposed shared responsibility         | Interaction, accessibility, responsive, and migration contracts are complete           |
| **Specified**                | Behavior and boundaries are decision-complete               | Implementation approach, tests, and migration slice are approved                       |
| **Ready for implementation** | Safe to schedule as component work                          | Contributor and milestone capacity are assigned                                        |
| **Implemented**              | Shared primitive exists, is tested, documented, and adopted | Main design-system specification is updated and obsolete page-specific code is removed |
| **Deferred**                 | Valid need intentionally postponed                          | A named product or technical condition changes                                         |

New entries begin as **Candidate**. Names are working descriptions until a
pattern becomes Implemented and joins the main component inventory.

## Prioritization

Priority reflects current repetition, accessibility risk, behavioral
inconsistency, and the amount of page-specific code a shared pattern could
retire.

| Priority | Meaning                                                                          |
| -------- | -------------------------------------------------------------------------------- |
| P0       | Foundation used by several workflows or carrying significant focus/keyboard risk |
| P1       | Repeated workflow pattern that should build on the P0 foundations                |
| P2       | Complex or specialized application pattern with fewer immediate consumers        |

Within a priority, specify foundations before consumers. Do not start a P1 or P2
implementation by embedding a second page-specific version of a missing P0
behavior.

## Foundation patterns

### Drawer or detail sheet

| Field                      | Plan                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status / priority          | **Implemented / P0**                                                                                                                                                                                                                   |
| Problem                    | Activity details and content/source details previously used separate backdrop and side-panel implementations with inconsistent dismissal, sizing, and narrow-screen behavior.                                                          |
| Current examples           | Shared `Drawer` in activity playback details and media asset details. layout and source editor detail backdrops remain page-specific.                                                                                                  |
| Shared responsibility      | A non-modal or modal side surface with title, optional description and actions, scroll ownership, backdrop behavior, and a full-page narrow-screen mode. It complements rather than replaces `Dialog`.                                 |
| Variants                   | End-aligned detail sheet. wide inspector sheet. narrow-screen full page. Start-aligned placement is out of scope until a real use appears.                                                                                             |
| States                     | Opening, open, closing, busy content, content error, and dirty form. Animation state must not become domain state.                                                                                                                     |
| Keyboard and screen reader | Move focus to the titled surface when modal. keep focus on the page when explicitly non-modal. contain focus only for modal use. Escape follows the same dirty-state policy as the visible close action. restore focus to the trigger. |
| Responsive behavior        | Use a bounded side width on wide screens, avoid hiding the underlying page when non-modal, and become a full-width page-like surface when content or viewport width makes a sheet cramped.                                             |
| Migration targets          | Activity playback and media asset details are complete. data-source and layout details migrate only when their editor-specific needs fit the shared contract.                                                                          |
| Dependencies               | Overlay layering rules, scroll locking, focus restoration, dirty-form confirmation policy.                                                                                                                                             |
| Completion criteria        | One interaction contract covers the first two consumers. focus and Escape tests pass. narrow-screen behavior is documented. duplicate backdrop and close logic is removed from migrated pages.                                         |

### Popover and menu foundation

| Field                      | Plan                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status / priority          | **Implemented / P0**                                                                                                                                                                                                                                                                                          |
| Problem                    | Account, create, filter, and timezone menus each managed placement, outside clicks, Escape, and keyboard behavior separately. Two were native `details` elements, which cannot close on an outside click. The timezone picker could only be dismissed by choosing a timezone.                                 |
| Current examples           | Shared `Popover` in the sidebar account menu, the header notification and create menus, the Screens, Content, and Activity filter panels, and the schedule timezone picker.                                                                                                                                   |
| Shared responsibility      | An anchored floating surface plus a menu interaction mode. Popover owns positioning and dismissal. Menu owns item navigation and selection semantics. Form-heavy filter panels use popover behavior without claiming menu semantics.                                                                          |
| Variants                   | Action menu, single-select menu, checkbox/filter popover, and informational popover. Tooltip behavior is excluded.                                                                                                                                                                                            |
| States                     | Closed, opening, open, closing, empty, loading, and disabled trigger.                                                                                                                                                                                                                                         |
| Keyboard and screen reader | Trigger exposes expanded and controlled state. Arrow keys navigate true menus. Escape closes and restores focus. Tab behavior depends on menu versus form-popover mode. Outside-pointer dismissal never strands focus.                                                                                        |
| Responsive behavior        | Flip or constrain within the viewport. Long content scrolls internally. Form-heavy popovers may become a sheet on narrow screens.                                                                                                                                                                             |
| Migration targets          | Complete. All seven page-specific surfaces migrated together, because the dismissal contract is the defect and a partial migration would have left the inconsistency it exists to remove.                                                                                                                     |
| Dependencies               | Layering and portal policy, focus restoration, collision-aware placement approach, drawer fallback.                                                                                                                                                                                                           |
| Completion criteria        | Met. `menu` and `form` modes are specified separately in the design system, with a keyboard matrix for each mode. `components/ui/Popover.test.tsx` covers both modes, edge placement, nested-overlay dismissal, and focus restoration. Every page-specific dismissal effect and `details` popover is removed. |

### Tabs

| Field                      | Plan                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status / priority          | **Candidate / P0**                                                                                                                                                                                                 |
| Problem                    | Shared `ViewTabs` now covers page-owned view navigation, but schedule targets and editor navigation still need a true in-page tab-panel contract.                                                                  |
| Current examples           | Schedule target tabs and layout sidebar navigation. Activity and screen details now use the implemented `ViewTabs` navigation pattern.                                                                             |
| Shared responsibility      | A tab list, tab triggers, and panels for in-place views. a visually related route-navigation variant remains links and must not claim ARIA tab semantics.                                                          |
| Variants                   | In-page tabs, route tabs, compact tabs, and tabs with an auxiliary state marker such as “Unsaved.”                                                                                                                 |
| States                     | Default, hover, focused, selected, disabled, and marked/dirty. Loading belongs to the panel, not the tab label.                                                                                                    |
| Keyboard and screen reader | In-page tabs follow the ARIA tabs pattern with Arrow, Home, and End navigation and deliberate automatic or manual activation. route tabs remain normal links. selected and dirty states are conveyed beyond color. |
| Responsive behavior        | Preserve readable labels. allow contained horizontal scrolling when a small number cannot fit. use a select or navigation list only when information architecture, not width alone, justifies it.                  |
| Migration targets          | Specify schedule target tabs first. editor navigation only if its behavior matches the final in-page contract.                                                                                                     |
| Dependencies               | Route ownership rules, dirty-state representation, focus-ring and overflow treatment.                                                                                                                              |
| Completion criteria        | Route and in-page contracts cannot be confused. keyboard tests cover the in-page variant. unsaved markers are announced appropriately. at least two existing tab groups migrate.                                   |

### Pagination

| Field                      | Plan                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status / priority          | **Implemented / P0**                                                                                                                                                                                           |
| Problem                    | Growing collections need consistent navigation, result context, and disabled behavior.                                                                                                                         |
| Current examples           | Shared `Pagination` in cursor-paginated Activity reports.                                                                                                                                                      |
| Shared responsibility      | Previous/next navigation with current-page context and optional bounded page choices. Data fetching, URL query state, and total-count authority remain with the feature.                                       |
| Variants                   | Previous/next only. bounded page list when a known total makes it useful. Infinite scrolling is excluded for operational records.                                                                              |
| States                     | First page, middle page, last page, loading next page, unknown total, known total, and empty result after filtering.                                                                                           |
| Keyboard and screen reader | Use navigation semantics with a specific accessible label. identify the current page. unavailable navigation is actually disabled or omitted consistently. loading changes are announced without moving focus. |
| Responsive behavior        | Collapse bounded page choices before previous/next controls. keep current position text visible. never force horizontal page scrolling.                                                                        |
| Migration targets          | Activity reports are complete. content, screens, users, and deployment history adopt it only when their APIs paginate.                                                                                         |
| Dependencies               | Query-parameter convention, collection loading policy, result-count language.                                                                                                                                  |
| Completion criteria        | Works with known and unknown totals. back/forward navigation preserves state. focus stays stable during fetches. Activity migrates with equivalent behavior.                                                   |

### Filter toolbar, filter menu, and filter chips

| Field                      | Plan                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status / priority          | **Candidate / P0**. The `FilterBar` and `FilterChips` primitives exist and Activity reports use them. The status stays Candidate because the second list-page migration has not happened. `docs/design-system.md` lists the primitives in its inventory as available code. This entry tracks the adoption of the pattern, which is not complete. |
| Problem                    | Content, data sources, widgets, and activity reports repeat filters, overflow menus, active counts, chips, and clear actions with different layouts and language.                                                                                                                                                                                |
| Current examples           | Shared `FilterBar` and `FilterChips` in Activity reports. The overflow filter panel is now the shared `Popover`. Screens and Content still use their own toolbars and chips.                                                                                                                                                                     |
| Shared responsibility      | A composable filter region that owns layout and active-filter presentation. Features continue to own filter definitions, URL/query serialization, and server parameters.                                                                                                                                                                         |
| Variants                   | Inline select/search controls, overflow filter popover, single removable chip, active-filter group, and clear-all action.                                                                                                                                                                                                                        |
| States                     | No filters, active filters, invalid/stale URL value, loading results, no matching results, and disabled filter.                                                                                                                                                                                                                                  |
| Keyboard and screen reader | Filter region has an accessible label. Controls retain native or shared semantics. Removal names the filter and value. Result updates are announced separately. Active count is textual, not color-only.                                                                                                                                         |
| Responsive behavior        | Keep the highest-value search/filter inline, move secondary filters to the shared popover, wrap chips without shrinking their removal targets, and keep clear-all discoverable.                                                                                                                                                                  |
| Migration targets          | Content and data-source list toolbars first. Activity is complete. Widgets after common behavior is proven.                                                                                                                                                                                                                                      |
| Dependencies               | Popover foundation (Implemented), Signal Select, URL-state convention, collection status language.                                                                                                                                                                                                                                               |
| Completion criteria        | Filter definitions render consistently in inline and overflow placements. Chip removal and clear-all are keyboard accessible. URL restoration is tested. Two list pages migrate without loss of filter capability.                                                                                                                               |

## Workflow patterns

### Drop zone and upload queue

| Field                      | Plan                                                                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status / priority          | **Candidate / P1**                                                                                                                                                                                                            |
| Problem                    | Media selection and player-release upload implement separate drag/drop surfaces, file validation, queues, progress, retry, and failure presentation.                                                                          |
| Current examples           | Content upload queue, content-picker upload dialog, picker drop zone, and player-release drop zone.                                                                                                                           |
| Shared responsibility      | Accessible file selection and drag/drop presentation plus queue rows for local validation, transfer progress, completion, retry, cancellation, and failure. Upload transport and accepted-file policy remain feature-owned.   |
| Variants                   | Single-file and multi-file drop zone. compact and detailed queue row. Folder upload is excluded.                                                                                                                              |
| States                     | Idle, drag acceptable, drag rejected, validating, queued, uploading, processing handoff, complete, failed, canceled, and retrying.                                                                                            |
| Keyboard and screen reader | The drop zone includes a normal file input and activation control. drag/drop is optional enhancement. queue changes use restrained live announcements. progress exposes name and value. retry and remove are labeled buttons. |
| Responsive behavior        | Instructions and browse action stack cleanly. queue metadata wraps without displacing progress or actions. long filenames truncate visually while remaining available to assistive technology.                                |
| Migration targets          | Content picker and main content upload first. release APK upload only after its signing and authorization differences are preserved.                                                                                          |
| Dependencies               | Notice/status primitives, progress representation, dialog or sheet host, feature-specific validation contracts.                                                                                                               |
| Completion criteria        | Pointer, keyboard, and file-input paths are equivalent. rejected files explain why. mixed-success queues remain operable. cancellation and retry are tested. no upload secrets or local paths leak into messages.             |

### Detail and inspector layout

| Field                      | Plan                                                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status / priority          | **Candidate / P1**                                                                                                                                                                                       |
| Problem                    | Media, sources, screens, and editor selections repeat title/preview/metadata/action arrangements without a shared information hierarchy.                                                                 |
| Current examples           | Asset details, source editors, screen detail with live preview, and layout editor selection panels.                                                                                                      |
| Shared responsibility      | Structural regions for identity, preview, status, metadata, editable sections, and actions. Hosting in a page, drawer, or editor pane remains composable.                                                |
| Variants                   | Read-only detail, editable inspector, and detail with preview. A generic schema-driven property editor is excluded.                                                                                      |
| States                     | Loading, ready, stale, unavailable preview, partial metadata, read-only permission, dirty, saving, save failure, and conflict where supported by the feature.                                            |
| Keyboard and screen reader | Heading hierarchy identifies the selected object. metadata uses lists or tables appropriately. save state is announced. focus does not jump when selection updates unless the user initiated navigation. |
| Responsive behavior        | Place preview and details side by side only when both remain useful. stack on narrow screens. keep primary actions reachable. long technical values wrap or copy without widening the page.              |
| Migration targets          | Asset and source details first. screen details second. layout inspector last because it has editing-specific selection behavior.                                                                         |
| Dependencies               | Drawer/detail sheet, preview panel, form patterns, sticky-action policy.                                                                                                                                 |
| Completion criteria        | Shared structure works in both a page and sheet. read-only and editing modes remain distinct. two detail experiences migrate with simpler heading and action markup.                                     |

### Preview frame and panel

| Field                      | Plan                                                                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status / priority          | **Candidate / P1**                                                                                                                                                                                                            |
| Problem                    | Asset, layout, source, branding, native-app, and live-screen previews represent loading and unavailable states differently and do not share aspect-ratio or metadata conventions.                                             |
| Current examples           | Asset previews, layout preview overlay, branding preview, data-source previews, native-app preview, and live preview panel.                                                                                                   |
| Shared responsibility      | A bounded visual frame with aspect ratio, fallback, optional status banner, and adjacent preview metadata. Rendering the underlying media or widget remains feature-owned.                                                    |
| Variants                   | Thumbnail, contained preview, fullscreen preview, and privacy-sensitive live preview.                                                                                                                                         |
| States                     | Loading, ready, stale, unsupported, unavailable, failed, empty, offline, and privacy-restricted.                                                                                                                              |
| Keyboard and screen reader | Decorative thumbnails use empty alternative text when adjacent text names the object. meaningful previews receive a concise accessible name. stale/error state is textual. fullscreen entry and exit are keyboard accessible. |
| Responsive behavior        | Preserve content aspect ratio. contain rather than crop operational previews by default. scale metadata below the frame on narrow screens. never let preview dimensions force page overflow.                                  |
| Migration targets          | Shared asset and source thumbnails first. live preview second. layout fullscreen preview only after its editor controls are accounted for.                                                                                    |
| Dependencies               | Status/notice primitives, aspect-ratio metadata, dialog or sheet behavior for expanded preview.                                                                                                                               |
| Completion criteria        | State vocabulary and aspect-ratio rules are shared. alt-text guidance is tested in migrated consumers. stale and unavailable states cannot be mistaken for current output.                                                    |

### Modal consolidation

| Field                      | Plan                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status / priority          | **Candidate / P1**                                                                                                                                                                                |
| Problem                    | Several workflows build custom modal backdrops despite an implemented `Dialog`, producing inconsistent focus containment, Escape handling, labels, and layering.                                  |
| Current examples           | Playlist creation and Layout selection plus screen revocation now use `Dialog`. content picker, upload dialog, layout preview/details, and definition editors still require consolidation.        |
| Shared responsibility      | Define when existing `Dialog` is sufficient, which missing composition features it needs, and which experiences should instead use a drawer, sheet, or full page.                                 |
| Variants                   | Small confirmation, form dialog, large bounded task, and nested child task only if a non-layered alternative cannot work.                                                                         |
| States                     | Opening, ready, submitting, validation error, server error, dirty close attempt, and closing.                                                                                                     |
| Keyboard and screen reader | Native dialog semantics, labeled title, initial focus policy, contained tab order, Escape/cancel parity, and trigger-focus restoration are mandatory. Nested modal focus traps are prohibited.    |
| Responsive behavior        | Small dialogs retain margins. larger form dialogs become near-fullscreen or full-page on narrow screens. actions remain visible without obscuring focused fields.                                 |
| Migration targets          | Simple playlist and screen confirmations are complete. content-picker and editor overlays wait for their larger pattern dependencies.                                                             |
| Dependencies               | Existing `Dialog`, drawer/detail sheet, dirty-form confirmation, scroll locking and layering policy.                                                                                              |
| Completion criteria        | A decision table assigns every current custom backdrop to Dialog, sheet, or page. Dialog gains only proven composition needs. at least two custom modal implementations migrate with focus tests. |

## Complex application patterns

### Reorderable list and timeline

| Field                      | Plan                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status / priority          | **Candidate / P2**                                                                                                                                                                                              |
| Problem                    | Playlist ordering combines drag handles, playback settings, per-item actions, duration context, and empty states in one page-specific timeline. Future ordered content may repeat the interaction.              |
| Current examples           | Playlist timeline and timeline items.                                                                                                                                                                           |
| Shared responsibility      | Ordered-item structure, selection, drag presentation, keyboard reordering, position announcements, and stable per-item action placement. Domain-specific playback controls remain in the item body.             |
| Variants                   | Compact ordered list and detailed timeline. Freeform canvas ordering is excluded.                                                                                                                               |
| States                     | Empty, ready, selected, dragging, keyboard-moving, disabled/read-only, saving order, save failure, and item validation warning.                                                                                 |
| Keyboard and screen reader | Every drag operation has an equivalent keyboard move. announce item name and new position. preserve focus after reorder. handles have specific labels. read-only order remains understandable without controls. |
| Responsive behavior        | Stack item metadata and actions without losing order. provide explicit move actions when dragging is imprecise. never require horizontal dragging.                                                              |
| Migration targets          | Playlist editor first. no second consumer should be invented merely to justify abstraction.                                                                                                                     |
| Dependencies               | Focus management, live announcement policy, drag library assessment, optimistic-save and rollback behavior.                                                                                                     |
| Completion criteria        | Pointer and keyboard reordering reach identical outcomes. rollback restores order and focus. position announcements are tested. playlist semantics remain feature-owned.                                        |

### Split-pane and editor-sidebar shell

| Field                      | Plan                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status / priority          | **Candidate / P2**                                                                                                                                                                                          |
| Problem                    | Layout editing and configuration workflows need persistent navigation, a central work area, inspectors, and actions, but current arrangements are tightly coupled to individual pages.                      |
| Current examples           | Layout builder sidebar, content shelf, canvas, inspector, preview layout, and settings navigation/form split.                                                                                               |
| Shared responsibility      | Structural slots, minimum/maximum pane sizes, overflow ownership, focus traversal, optional resizing, and narrow-screen mode switching. It does not own editor state.                                       |
| Variants                   | Navigation/content, workbench/inspector, and three-region editor. User-resizable panes remain optional until persistence and accessibility are specified.                                                   |
| States                     | Default, collapsed optional pane, narrow-screen active region, loading work area, read-only editor, and unsaved changes.                                                                                    |
| Keyboard and screen reader | Landmarks and headings identify regions. pane resizing, if added, has a keyboard equivalent and announced value. collapsed panes remain reachable. focus is preserved when switching narrow-screen regions. |
| Responsive behavior        | Wide screens may show multiple regions. narrow screens show one primary region with explicit navigation among regions. no essential editor action depends on simultaneous visibility.                       |
| Migration targets          | Extract only after the layout editor's regions stabilize. settings may consume a simpler two-region form if behavior genuinely matches.                                                                     |
| Dependencies               | Tabs or region navigation, inspector layout, sticky-action policy, resize persistence decision.                                                                                                             |
| Completion criteria        | Region ownership and narrow-screen flow are specified with a wire-level text description. keyboard resizing is resolved before resizable UI ships. editor state remains outside the shell.                  |

### Activity and event timeline

| Field                      | Plan                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status / priority          | **Candidate / P2**                                                                                                                                                           |
| Problem                    | Activity overview renders chronological events separately from report tables and command history, while multiple domains need compact, trustworthy event presentation.       |
| Current examples           | Activity overview timeline, screen command history, deployment history, and processing events.                                                                               |
| Shared responsibility      | Chronological list structure, timestamp placement, actor/source metadata, tone, grouping, and optional detail action. Event fetching and domain labels remain feature-owned. |
| Variants                   | Compact recent activity, detailed audit timeline, and command/deployment history.                                                                                            |
| States                     | Loading, empty, partial page, live update, failed load, event with missing actor, and event with expandable detail.                                                          |
| Keyboard and screen reader | Use a semantic list. preserve chronological reading order. timestamps include timezone context where needed. expansion is a labeled control. tone never replaces event text. |
| Responsive behavior        | Stack timestamp and metadata when space is limited. wrap event descriptions without separating them from actor or object context. detail actions remain reachable.           |
| Migration targets          | Activity overview and screen command history first. deployment history after shared metadata needs are confirmed.                                                            |
| Dependencies               | Pagination, status language, date/time formatting guidance, drawer for event detail.                                                                                         |
| Completion criteria        | One event model adapter can feed two domains without erasing domain language. chronology and timezone behavior are tested. missing metadata has explicit fallback copy.      |

### Responsive editor alternatives

| Field                      | Plan                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status / priority          | **Candidate / P2**                                                                                                                                                                       |
| Problem                    | Wide layout, schedule, mapping, and preview workflows can become technically responsive while remaining unusable on narrow screens.                                                      |
| Current examples           | Layout editor, schedule builder, source mapping editors, playlist timeline, and screen detail/live-preview layout.                                                                       |
| Shared responsibility      | A decision framework and supporting region-navigation patterns for converting simultaneous desktop regions into focused narrow-screen steps without losing state or capability.          |
| Variants                   | Region switcher, step sequence, collapsible secondary preview, and read-only narrow-screen fallback only where editing cannot be made safe.                                              |
| States                     | Active region, completed region, invalid hidden region, dirty region, preview unavailable, and orientation/viewport change.                                                              |
| Keyboard and screen reader | Region changes are explicit controls. validation identifies and navigates to hidden invalid content. focus moves to the new region heading. state survives viewport changes.             |
| Responsive behavior        | Define capability by available space and task, not device labels. never shrink a canvas or dense mapping grid below useful interaction size. preserve a route to every essential action. |
| Migration targets          | Screen detail/preview and schedule builder first. layout editor and source mapping after their task-specific minimum widths are measured.                                                |
| Dependencies               | Tabs/region navigation, split-pane shell, preview panel, validation-summary behavior.                                                                                                    |
| Completion criteria        | Each target has an explicit wide and narrow task flow. automated tests cover state preservation across layout changes. no essential action or error exists only in a hidden region.      |

### Operational reporting chart

| Field                | Plan                                                                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status / priority    | **Deferred / P3**                                                                                                                                                                                                                                                                       |
| Problem              | Activity reporting could plot compliance, uptime and incident rates over time. It currently does not, and no shared chart primitive exists.                                                                                                                                             |
| Current examples     | Uptime strips are the only chart-like element in Studio, and they are page-specific.                                                                                                                                                                                                    |
| Why deferred         | Every reporting figure added so far is one an operator needs exactly, not approximately — expected minutes, missed minutes, time to recover. Tiles, tables and timelines answer that better than a plotted series, and building a chart system before a real need would be speculative. |
| Reconsider when      | A reporting question genuinely needs shape over time rather than a figure, such as compliance trend across a term.                                                                                                                                                                      |
| Specification needed | Categorical and sequential palettes validated for the existing light and dark themes, axis and legend rules, an accessible non-color encoding, an empty and a no-data state distinct from zero, and behavior when a series is truncated by a row limit.                                 |
| Exclusions           | No decorative charts. No chart that displays a figure a reader is expected to read precisely.                                                                                                                                                                                           |

## Specification gate

A Candidate advances to **Specified** only when its entry or linked design note
answers all of the following:

- What repeated Tilecast problem does it solve, and which consumers will
  migrate first?
- What behavior belongs to the shared pattern, and what remains feature-owned?
- Which variants are required now, and which are explicitly excluded?
- How do loading, empty, error, disabled, dirty, and read-only states behave when
  they apply?
- What are the complete keyboard, focus, screen-reader, and reduced-motion
  contracts?
- What happens at narrow widths, zoomed text, and constrained height?
- Which existing primitive or candidate must it compose rather than duplicate?
- What tests demonstrate the contract, and what page-specific code will be
  removed?

A Specified pattern advances to **Ready for implementation** only with an
approved first migration slice. A pattern becomes **Implemented** only after the
shared code, tests, migrated consumer, and main design-system documentation land
together.

## Roadmap maintenance

- Add a Candidate only when a current or approved product workflow demonstrates
  the need.
- Link concrete repository examples. Do not justify a component with generic
  design-system completeness.
- Prefer composition of smaller foundations over a single configurable
  component that owns feature state.
- Record exclusions so implementation does not expand opportunistically.
- Move stale proposals to Deferred with a reason instead of leaving ambiguous
  promises.
- When a pattern becomes Implemented, update `docs/design-system.md`, migrate at
  least one real consumer, and remove claims here that it is unavailable.
