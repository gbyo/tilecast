# Studio Base Nova migration

## Registry provenance

The migration starts from `origin/main` at `bc3c47c4b4281bdc241ee7c56cfd0b749734a022`.
The GitHub connector confirms that this commit is the current `main` head.
Direct Git HTTPS fetch fails in the development environment.
A final SSH fetch confirms the same `origin/main` commit.

The official shadcn CLI version is `4.22.1`.

| Setting                   | Before           | After               |
| ------------------------- | ---------------- | ------------------- |
| Resolved preset           | `bIkf1TU`        | `b2fA`              |
| Registry style            | `base-vega`      | `base-nova`         |
| Primitive base            | Base UI          | Base UI             |
| Base, theme, chart colors | Neutral          | Neutral             |
| Font, heading font        | Geist, inherit   | Geist, inherit      |
| Icons                     | Lucide           | Lucide              |
| Radius                    | small, `0.45rem` | default, `0.625rem` |
| Menu accent, color        | subtle, default  | subtle, default     |
| CSS variables, RTL        | enabled, false   | enabled, false      |

The existing Vite and Tailwind architecture stays in place.
The migration uses these commands in a disposable registry worktree:

```sh
npx shadcn@latest preset resolve -c apps/dashboard --json
npx shadcn@latest info -c apps/dashboard --json
npx shadcn@latest apply b2fA -c apps/dashboard --yes
npx shadcn@latest apply bIkf1TU -c apps/dashboard --yes
```

The official `shadcn/preset` encoder constructs `b2fA` from the resolved values.
The second apply provides the current official Vega comparison.
The merge compares the original files, official Vega output, and official Nova output.
It retains the local integrations below.
It does not copy components from Byline.
Byline provides a geometry reference only.

The default Nova radius replaces the small Vega radius at the preset level.
The component radius scale comes from that one value.
The review compares live Nova dialogs and context menus at both radius values.
The default value gives fields, buttons, menus, and modal corners a consistent curve.
The small value gives those surfaces a sharper treatment.
The migration selects the default without per-component radius compensation.
Nova reduces standard controls from 36 px to 32 px and removes control shadows.
The smaller controls suit Studio's persistent toolbars and operational collections.
Comfortable keeps that official geometry.

## Shared component audit

All 55 production files in `components/ui` have official registry equivalents.
No production component in this directory is a Tilecast-only registry substitute.
The test files are Tilecast-specific regression coverage.

### Category 1: registry components without domain behavior

These components take the current official Nova structure and geometry:

`accordion`, `alert`, `aspect-ratio`, `attachment`, `avatar`, `badge`, `bubble`,
`button`, `button-group`, `calendar`, `card`, `checkbox`, `collapsible`, `command`,
`dropdown-menu`, `empty`, `field`, `hover-card`, `input`,
`input-group`, `input-otp`, `kbd`, `label`, `menubar`, `native-select`, `popover`,
`progress`, `radio-group`, `resizable`, `scroll-area`, `select`, `separator`,
`slider`, `switch`, `table`, `tabs`, `textarea`, `toggle`, `toggle-group`, `tooltip`.

Existing logical-direction utilities remain where they support the shared RTL contract.
They do not retain old heights, padding, shadows, or corner geometry.
The context-menu trigger also guards Control-click activation of nested controls.
Base UI continues to own the contextmenu event and menu lifecycle.
The activation guard applies to Apple Control-click.
Windows and Linux Control-click keep their normal activation behavior.

### Category 2: registry components with required integration

| Component       | Preserved integration                                                                 |
| --------------- | ------------------------------------------------------------------------------------- |
| `alert-dialog`  | `GrowNativePresentation` for native hosts                                             |
| `breadcrumb`    | Localized overflow label                                                              |
| `carousel`      | Localized controls and direction-aware keyboard behavior                              |
| `chart`         | Type-safe payload access and existing formatter contract                              |
| `combobox`      | Localized trigger, clear, and removable-chip labels                                   |
| `context-menu`  | Control-click activation guard for nested links and controls                          |
| `dialog`        | Native growth, localized close controls, viewport margins, caller width overrides     |
| `drawer`        | Base UI indent shell, native-host opt-out, scroll anchoring, coordinated swipe motion |
| `item`          | Semantic `render` composition for list groups and `min-w-0` content                   |
| `questionnaire` | Localized previous, next, skip, and submit defaults                                   |
| `sheet`         | Localized close control and logical-side compatibility                                |
| `sidebar`       | Localized mobile title and controls, logical direction, reduced motion                |
| `skeleton`      | System reduced-motion behavior                                                        |
| `spinner`       | Localized loading status                                                              |
| `toast`         | Localized close label and feedback above modal layers                                 |

The dialog retains Nova's 384 px default maximum width, 16 px padding, and footer treatment.
It expresses the width without a responsive override so a caller can replace the maximum width.
Full-screen pickers and bounded complex-task dialogs keep their explicit layout.
Their flush footers cancel Nova's default negative margins.

### Category 3: Tilecast compositions

Studio shell, action models, density policy, native presentation integration,
and domain editors stay outside the registry component layer.
Plugins use the supported `@tilecast/studio` and `@tilecast/studio/ui/*` exports.
No Plugin API generation changes.

## Interaction audit

| Surface                               | Result                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fleet table and cards                 | Shared row action model drives visible overflow and context menus. Existing batch selection suppresses individual commands.                                                       |
| Display Groups and members            | Context menus reuse the existing action factory in table and narrow list presentations. Visible action buttons remain.                                                            |
| Schedules                             | Table and narrow list use one action model for both menus. Names expose full values.                                                                                              |
| Media, Layouts, Widgets, Data Sources | Existing shared overflow/context models remain. Collection density applies to list presentations.                                                                                 |
| Playlist Editor                       | Existing shared item-action model, pointer drag, menu reorder, and keyboard reorder remain. Rollback restores order and usable focus. Heading wraps instead of truncating.        |
| Layout Editor                         | Base UI open callbacks guard shortcuts. Apple Control-click does not start a move or clear canvas selection. Numeric inspector and arrange commands remain non-drag alternatives. |
| Plugin Store and detail               | Navigation cards retain their primary links. No context menu is added to a card with only navigation. Shared dialog geometry reaches plugin-hosted UI.                            |
| Settings and pickers                  | Existing focused dialogs, complex-task sheets, full-screen narrow pickers, destructive confirmations, and passive feedback remain.                                                |
| Sidebar                               | Existing routes, active state, offcanvas behavior, mobile Sheet, utility sections, and keyboard shortcut remain.                                                                  |
| Content batch toolbar                 | Actions wrap at narrow widths instead of requiring horizontal scrolling.                                                                                                          |

Comfortable previously used Vega geometry.
Compact previously wrote a root attribute with no layout consumer.
Compact now tightens table rows, marked resource lists, and normal page vertical spacing.
It never changes the Tailwind spacing multiplier, text, focus, icons, controls, or dialog geometry.
The root normalizes unsupported values to Comfortable.
Both modes retain expanded shared targets for coarse pointers.

## Review references

- [shadcn CLI and preset apply](https://ui.shadcn.com/docs/cli)
- [shadcn theming](https://ui.shadcn.com/docs/theming)
- [Base UI Menu](https://base-ui.com/react/components/menu)
- [Base UI Context Menu](https://base-ui.com/react/components/context-menu)
- [Apple menus](https://developer.apple.com/design/human-interface-guidelines/menus)
- [Apple context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus)
- [Apple toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- [Apple modality](https://developer.apple.com/design/human-interface-guidelines/modality)
- [Apple alerts](https://developer.apple.com/design/human-interface-guidelines/alerts)
- [Apple feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)
- [Apple undo and redo](https://developer.apple.com/design/human-interface-guidelines/undo-and-redo)
- [Carbon data tables](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines)
- [Carbon menu buttons and overflow](https://www.carbondesignsystem.com/building-blocks/core/components/menu-buttons/guidelines)
- [Carbon menu behavior](https://www.carbondesignsystem.com/building-blocks/core/components/menu/guidelines)
- [WCAG dragging movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
- [WCAG minimum target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)

These references guide focused interaction changes.
They do not change Tilecast routes, permissions, domain data, or Player behavior.

## Validation and visual review

The unchanged production Demo Mode build passes all 38 existing Linux/Chromium visual tests.
The Linux environment uses the official Playwright `v1.63.0-noble` image.
The standard helper first fails on an unrelated Electron binary download.
A clean archive of the same commit passes with Dashboard-only workspace dependencies.
The test configuration and 0.5% comparison threshold stay unchanged.

The final production Demo build passes all 45 functional browser tests.
The Linux browser reaches that server through a TCP loopback forward.
Loopback keeps the secure-context APIs available on the HTTP development origin.
An initial run through `host.docker.internal` fails because that origin does not
provide `crypto.randomUUID` to existing authoring workflows.
The loopback run changes no application code, API responses, or test assertions.

| Check                                                                 | Result                            |
| --------------------------------------------------------------------- | --------------------------------- |
| `npm run format:check`                                                | Pass                              |
| `npm run lint`                                                        | Pass, no warnings                 |
| `npm run build`                                                       | Pass, TypeScript and Vite         |
| `npm test`                                                            | 301 files, 3,381 tests pass       |
| `i18n:scan --check --base origin/main`, changed runtime paths         | No new untranslated strings       |
| `architecture:scan --check --base origin/main`, changed runtime paths | No new findings                   |
| `make plugins-check`                                                  | Three plugins, 175 SDK tests pass |
| `make docs-check`                                                     | Pass                              |
| `npm run docs:build`                                                  | 572 pages and link checks pass    |
| `TILECAST_DEMO_PORT=18090 make demo`                                  | Production build ready            |
| `playwright test -c e2e/playwright.config.ts`                         | 45 tests pass                     |
| `npx shadcn@latest preset resolve -c apps/dashboard --json`           | Nova, `b2fA`, no fallbacks        |
| `git diff --check`                                                    | Pass                              |

The proposed captures pass all 49 visual tests.
The final comparison run also passes all 49 tests without snapshot updates.
All 43 baseline images receive manual review before the comparison run.
The baseline changes consist of 32 replacements and 11 new captures.
The review checks layout, wrapping, visible actions, modal spacing, and menu alignment.
Full-resolution checks include dialogs, dark editors, resource lists, and narrow editors.
Gray regions are the existing dynamic-data masks.

The files are under `e2e/visual/__screenshots__/linux/`:

| Review group                | Baseline names without `.png`                                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell and collections       | `overview`, `fleet`, `fleet-compact`, `groups`, `group-detail`, `content`, `content-list`, `widgets`, `data-sources`, `playlists`, `layouts`, `schedules`, `plugins`, `plugin-store`, `plugin-detail`, `activity-proof-of-play`, `settings`, `users` |
| Screen and action states    | `fleet-bulk-review`, `fleet-context-menu`, `screen-online`, `screen-stale`, `screen-disabled`, `screen-playback-explanation`, `screen-playback-explanation-mobile`, `screen-scope-editor`                                                            |
| Dialogs                     | `playlist-create-dialog`, `datasource-create`                                                                                                                                                                                                        |
| Playlist and layout editors | `playlist-editor`, `playlist-editor-dark`, `layout-editor`, `layout-editor-1024`, `layout-editor-820`, `layout-editor-768`, `layout-editor-390`, `layout-widget-preview`                                                                             |
| Schedule and Widget editors | `schedule-editor`, `schedule-editor-mobile`, `widget-editor`, `widget-editor-dark`, `widget-editor-data`, `widget-editor-validation`, `widget-editor-mobile`                                                                                         |

The viewport review covers 1440, 1024, 820, 768, and 390 px.
Existing mobile captures also cover 375 px.
Browser checks exercise fine pointers, keyboard menus, and emulated coarse pointers.
Physical touch devices and native iOS presentation are not tested in this migration.
The native presentation integration has unit coverage.
No required UX change is deferred.
