# Public product screenshots

This generator captures the production Studio from a real Demo Mode Server.
The database and UI are real. No API responses are mocked.

```sh
npx playwright install chromium
make demo
npm run docs:screenshots
npm run docs:check
npm run docs:build
```

Run this suite separately from functional and visual tests. All three suites
reset the same installation. Use `TILECAST_E2E_BASE_URL` or
`TILECAST_DEMO_PORT` to select a different demo address. The shared global
setup refuses a server that does not report Demo Mode.

Each capture starts with a kitchen-sink reset. Chromium uses a 1440 × 1000
viewport, scale 1, en-US, America/Chicago, light appearance, and reduced motion.
Only the Clock editor uses the visual suite's fixed browser Date. Other
captures use real time, so contact ages and upcoming dates match the Server.
The shared render helper waits for loading indicators, toasts, fonts, decoded
images, and Widget completion. Captures disable animations and hide the caret.
Only the Demo Mode notice is hidden: the banner and its compact editor badge.
There are no volatility or privacy masks.

The suite writes these named PNG sources in
`apps/docs/src/assets/screenshots/`. It does not delete other assets. Required
states have assertions before capture, and each completed image is printed.
Failures produce traces and diagnostic screenshots under `test-results/`.

## Inventory

| PNG                      | Demo route and state                                                                                               | Public pages                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| studio-overview          | `/`, Needs attention and operational sections                                                                      | Home, Operations / Overview                |
| fleet                    | `/screens`, populated district Fleet                                                                               | Getting started, Studio, Screen status     |
| media-library            | `/assets`, eight Ready images sorted by Name                                                                       | Media                                      |
| data-source-providers    | `/data-sources/new`, provider catalog crop                                                                         | Data Sources                               |
| widget-editor            | `/widgets/de30000a-0000-4000-8000-000000000009`, Lobby Clock ready at Small zone size                              | Widgets                                    |
| playlist-editor          | `/playlists/de300005-0000-4000-8000-000000000001`, Morning Announcements with first item selected                  | Playlists                                  |
| layout-editor            | `/layouts/de300006-0000-4000-8000-000000000001`, Hallway Split canvas                                              | Layouts                                    |
| campaign-editor          | `/campaigns/de300008-0000-4000-8000-000000000001`, Homecoming Week draft                                           | Campaigns                                  |
| schedule-editor          | `/schedules/de300007-0000-4000-8000-000000000003`, Morning Broadcast weekly editor                                 | Schedules                                  |
| pair-screen              | `/screens` → pending request Review, approval dialog crop                                                          | Pair a display                             |
| display-group            | `/groups/de300004-0000-4000-8000-000000000001`, Cafeteria Displays Members tab                                     | Display Groups                             |
| bulk-change-review       | `/screens/bulk`, select Cafeteria East and Front Office, preview General Information assignment; stop before Apply | Bulk changes                               |
| live-preview-unavailable | `/screens/de300003-0000-4000-8000-000000000001`, actual Capture error panel crop                                   | Live preview / When preview is unavailable |
| plugins                  | `/plugins`, installed Countdown Bar                                                                                | Plugins                                    |
| users                    | `/settings/users`, seeded district accounts                                                                        | Users and roles                            |
| backups                  | `/settings/operations/backups`, create and verify a real archive; Available backups crop                           | Backups                                    |

File names have a `.png` extension. The Overview and Fleet assets are reused.
No duplicate files are needed for operations pages.

Player Updates has no seeded verified release or deployment. Content review,
Content submissions, Forms, and Approvals have no seeded submitted record.
These images are omitted until useful fixtures exist. A successful Live preview
is omitted because Demo Players cannot render captures; the error panel belongs
only beside the unavailable-state explanation. Do not manufacture these states
or weaken production verification to obtain a picture.

## Review and maintenance

Inspect every generated PNG before commit. Check the required content,
readable controls, crops, complete image and Widget rendering, and absence of
the Demo banner, secrets, skeletons, covering toasts, and unintended overlays.
Keep harmless real timestamps when the useful context requires them.

Build the docs and inspect the affected pages in light and dark appearance at
desktop, tablet, and phone widths. Check that images stay within their source
size and cannot cause horizontal page scrolling. Check the homepage image's
position before enabling priority loading.

When UI changes, regenerate the affected assets with this command and review
them again. Keep source captures as PNG; Astro handles responsive optimization.
CI checks docs and links but never regenerates or accepts source captures.
Public images are independent of the visual suite's 0.5% comparison contract.
