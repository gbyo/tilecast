# External-Widget conformance fixture package

One reusable third-party Widget pair for every Player host. The bundles
are static classic scripts; the frame document is always built from
the checked-in generated Server template
(`apps/server/internal/extensions/sandbox/frame.gen.go`, itself
generated from the SDK frame builder), so the served bytes are
byte-identical to production frames and to what the isolation spike
measures. No consumer keeps a private copy: the Edge headless e2e
builds its frames from these files at run time, the Android device
test serves checked-in builds of the same files, and the SDK and
Browser suites use the same sources.

- `bundle.js`: `acme.athletics.scoreboard` v2. Gates ready on compiled
  configuration, a prepared Data Source document, a granted
  media URI whose bytes load through the host's confined media path,
  and a sane projected clock. Any missing input fails the mount with a
  bounded `widget_*` code instead of rendering half a Widget.
- `hostile.js`: `acme.evil.probe` v1. Probes parent/top access, cookies,
  storage, credential globals, and one network fetch to a
  server-controlled canary URL from its config, then always signals
  ready. Containment is proven by absence: zero canary hits, a console
  CSP violation, and a completed lifecycle.

Behavior coverage (each names its proving consumer):

| Behavior | Proven by |
| --- | --- |
| Configuration compile | Bundle gates ready on `label`; Edge e2e, SDK mount tests |
| Structured Data Source values | Bundle requires `schedule` datasets; Edge e2e, runtime projection tests |
| Host-projected clock/context | Bundle requires clock within 60 s; Edge e2e |
| Safe media references | Bundle requires the grant URI and its bytes load; Edge e2e, runtime projection tests |
| Mount and ready signaling | `widget_shown` evidence; Edge e2e, SDK executor tests |
| Updates without remount | Port revision updates; SDK sandboxed-executor tests |
| Multiple instances | Two scoreboard items, distinct evidence; Edge e2e |
| Layout-zone placement | Scoreboard in a Layout zone with `zoneId` evidence; Edge e2e |
| Playlist placement | Fullscreen scoreboard item; Edge e2e |
| Cleanup and reactivation | Renderer restart re-reports evidence; Edge e2e |
| Temporary offline playback | Cached frame bytes play with the origin gone; Edge e2e |
| Hostile containment | Zero canary hits, CSP console violation, lifecycle completes; Edge e2e, Browser frames e2e, SDK spike |
