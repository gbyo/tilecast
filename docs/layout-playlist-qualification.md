# Mixed Layout playlist qualification

The implementation uses Player Runtime for zone projection and playback.
Android, Edge, Browser, and Windows do not have separate zone schedulers.
The Server requires `layout.playlist_widgets@1` in addition to the selected
Widget presentation's capabilities. Nested Layout entries remain unsupported.

## Automated coverage

- Projection tests compare a timed component with a direct placement.
  They check authorized media and package frame grants.
- Zone actor tests check readiness timing, pause, stale events, looping,
  terminal holds, and a bounded retry when every item fails.
- Surface tests rotate image, component, video, and compatibility Widget.
  They check neighboring content, expected-empty state, errors, and disposal.
  They check sandbox execution grants and timed remote pages.
  YouTube tests check fixed slots, completion, duplicate ends, and disposal
  before the next player mounts.
- PostgreSQL tests check manifest order, video offsets, Data Documents,
  package frame claims, capability gates, readiness, YouTube limits, and
  transitive invalidation through Widgets, media, Data Sources, and plugins.
- Studio tests check mixed eligibility, zone dimensions, the selected date,
  readiness timing, stale callbacks, and removal of YouTube listeners.
- The Browser Player test uses the real Server and PostgreSQL. It checks
  image → Widget → video → Widget, a fixed neighbor, and a saved Widget edit.
- The `layout-mixed` conformance fixture checks the same rotation in the
  production Runtime. It checks first-class component disposal and the
  fixed neighbor after every occurrence. Video checks are semantic because
  independent decoders can capture different frames.

## Local verification on 2026-10-13

Electron and headless Edge WPE complete `layout-mixed`, `layout`, and
`widget-component`. Static visual checkpoints use the existing comparison
budget. The Browser Player mixed-zone test passes with the real Server.
Runtime, Studio, Browser Player, and shared Rust tests pass.

The CI Android API 34 emulator completes the Runtime conformance suite.
The `layout-mixed` fixture passes its semantic and static visual comparison
with Electron. See the
[qualification run](https://github.com/gbyo/tilecast/actions/runs/38363215281).
The local Android build cannot start because this checkout has no Android SDK.
No Android device or emulator is attached locally.
The Android build and the Windows and Edge required CI checks pass.
This evidence does not qualify physical Android TV, Fire TV,
Edge display hardware, or a Windows display.
Run `layout-mixed` on each release host before hardware qualification.

The local full Go integration run has one existing failure:
`TestPlaylistAssignmentManifestLifecycle` at its takeover assertion.
The same test fails on pristine `origin/main` with the local PostgreSQL
fixture. The Server CI for the server PR passes. The local Layout and Playlist
integration suites pass when that test is excluded.

The feature is also applied to the original working checkout.
Its Runtime tests, Studio build, mixed preview tests, shared Core checks,
Layout and Playlist integration tests, and real Browser mixed-zone test pass.
Broader checks report errors in separate Plugin Store and Edge update work.
That work remains outside the feature PRs.

## Commands

```sh
npm run build --workspace @tilecast/player-runtime
npm run typecheck --workspace @tilecast/player-runtime
npm test --workspace @tilecast/player-runtime
npm test
npm run lint
npm run build
npm run docs:build
npm test --workspace @tilecast/player-web
TEST_DATABASE_URL=postgres://localhost/tilecast_test npm exec -- playwright test -c apps/player-web/e2e/playwright.config.ts parity.spec.ts -g 'mixed Layout zone'
node packages/player-runtime/conformance/run.mjs --engine electron --out /tmp/layout-qualification --only layout-mixed,layout,widget-component
node packages/player-runtime/conformance/run.mjs --engine android --out /tmp/layout-qualification --only layout-mixed
python3 scripts/ci/check-player-architecture.py
make player-check player-test
```

Use the existing WPE and Windows conformance runners in
[Player Runtime](player-runtime.md). A headless fixture verifies the renderer;
it does not verify a physical TV, audio device, or host display integration.
