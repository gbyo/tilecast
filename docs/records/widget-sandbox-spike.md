# Widget sandbox spike (stage 5c gate)

Content-extension-model §12 allows runtime-installed external Widget code
only after an isolation spike is measured on Electron, WPE, and the
Android shared-runtime WebView. This document records the spike design,
the desktop-Chromium measurements, and the per-target procedure with the
gates each target must meet.

## Design under test

- One `WidgetExecutor` interface, implemented by `TrustedWidgetExecutor`
  (the shared `WidgetMount` over the release registry) and
  `SandboxedWidgetExecutor` (a verified bundle in an opaque-origin
  `allow-scripts` iframe). Both live in `@tilecast/widget-sdk` so the
  Player Runtime and Studio previews share them.
- The bridge carries only the Widget contract: bounded config, prepared
  data documents, host-authorized media URIs, and a serializable context
  snapshot with a projected wall-clock offset. Frames report only
  lifecycle states; reasons and codes pass through the trusted
  bounded-code rules.
- Every placement mints a 128-bit nonce and a per-attach hello token.
  The bootstrap announces its document with a hello; the parent answers
  once with `init` and the frame's `MessagePort`. The hello must come
  from the placement's own frame window at the expected origin (the
  frame origin for `hosted`, `"null"` for inline embeddings), and an
  inline document must echo its embedded token. Reports cross the port
  with a matching nonce; the parent drops anything else.
- The channel binds to the original document. A reload or navigation
  destroys the document's port, and the parent never sends `init` to a
  newly loaded document, so the connection dies with its document and
  the placement fails loudly. Outbound messages have a 4 MiB ceiling
  and cross by structured clone, which rejects unserializable values
  instead of silently dropping them.
- The parent ready timeout (`widget_ready_timeout`) fires on the host
  clock, matching trusted semantics. A type or version change remounts
  the frame with a fresh nonce.

## Questions and desktop-Chromium answers

The runner (`node spike/run.mjs` in `packages/widget-sdk`) drives
headless Chromium over CDP in real time. The harness CSP is
byte-identical to the Player Runtime policy. The runner serves the
harness page and the frame documents from two loopback origins, so the
frames neither inherit the page CSP nor require a policy change.

Q1: Can an opaque-origin frame execute a verified bundle under the
runtime CSP? Yes, but only from a host-served second origin. A
`srcdoc` frame inherits `script-src 'self'`, which never matches an
opaque origin, so its scripts never run. A `blob:` frame URL is
refused by `frame-src https: http:`. Both embeddings stay in the
harness as negative proofs. The `hosted` embedding serves the frame
document (bootstrap plus verified bundle) from a second origin, and
`frame-src` already permits it.

Q2: Does the bridge carry the full Widget contract? Yes. The
`hosted-ok` placement renders config text, two data-document
datasets, a `clock:ok` projection, and a loaded media grant.

Q3: Does the sandbox contain a hostile bundle? Yes. The hostile
fixture probes parent DOM access, top location reads, cookies,
`localStorage`, and network fetch. The screenshot verdict is
`parent:denied topread:denied cookie:denied storage:denied
fetch:rejected`, and the parent receives only the `ready` lifecycle
state.

Q4: Is mount latency acceptable? Yes. Median mount-to-ready is 29 ms
over ten fresh placements, against a 2000 ms gate. Eight concurrent
placements all report ready, the slowest in 52 ms. A container resize
moves the frame by CSS alone and the placement reports nothing new.

## Security findings

- The parent never posts `init` on frame load. A network-loaded frame
  navigates asynchronously, so the runner used to repost `init` when
  the frame loaded — but a reload or navigation fires that same event,
  and the replacement document must never receive the channel. The
  frame's hello now drives the single-shot transfer instead: the
  bootstrap announces whenever its document runs, however late the
  navigation lands.
- The frame reports the resolution outcome after an `update`. The
  element reports its own boot, but a synchronous fixture cannot
  re-fire lifecycle events on new inputs. Production must track input
  revisions in the frame. The follow-up list records this work.
- The runner uses real-time CDP polling, not
  `--virtual-time-budget`. Virtual time advances timers past real
  network loads, so frame `load` events land after the ready timeout
  and latency numbers lose meaning.
- The hostile verdict above holds under the unmodified runtime CSP.
  No policy change was required to run the harness.

## Gates

A target passes the spike when all of these hold:

1. Every harness case passes unmodified on that target.
2. The hostile screenshot shows `parent:denied topread:denied
cookie:denied storage:denied fetch:rejected`.
3. Median mount-to-ready stays under 2000 ms for ten fresh placements.
4. No runtime CSP change is required to run the harness.

## Per-target procedure

1. On a machine that serves HTTP to the target, run
   `node spike/run.mjs --keep` to generate `spike/dist/`. The flag
   also writes the frame documents to `spike/dist/frames/`.
2. Serve `spike/dist/` from one origin (port A) and
   `spike/dist/frames/` from a second origin (port B). The two
   origins must differ, or the frames inherit the page CSP and the
   `hosted` cases fail.
3. Open `http://<host>:<A>/harness.html?frames=<B>` in the target
   WebView.
4. Wait until the page title starts with `SPIKE_DONE`. If the title
   stays at `SPIKE_RUNNING` after 150 seconds, the run failed. Read
   the case rows for the failing case.
5. Read the `#results` JSON and screenshot the page.
6. Append the case table and the hostile verdict line below.

## Measurements

### Desktop Chromium (headless, 2026-10-06)

User agent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)
AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0
Safari/537.36`. Result: `SPIKE_DONE:12/12`.

| Case                | Result | Time                     |
| ------------------- | ------ | ------------------------ |
| `srcdoc-blocked`    | PASS   | 1030 ms                  |
| `blob-blocked`      | PASS   | 1031 ms                  |
| `hosted-ok`         | PASS   | 79 ms                    |
| `update`            | PASS   | 55 ms                    |
| `hostile-hosted`    | PASS   | 77 ms                    |
| `empty`             | PASS   | 29 ms                    |
| `error-bounded`     | PASS   | 29 ms                    |
| `silent-timeout`    | PASS   | 529 ms                   |
| `bad-shape`         | PASS   | 30 ms                    |
| `latency-median-ms` | PASS   | 29 ms over 10 mounts     |
| `scale-8`           | PASS   | 8/8 ready, slowest 52 ms |
| `resize-stable`     | PASS   | 29 ms                    |

Hostile verdict: `parent:denied topread:denied cookie:denied
storage:denied fetch:rejected`. The `hosted-ok` frame renders
`ok:hosted-ok sets:2 clock:ok` and `media:loaded`.

### Electron (TODO)

Not measured yet.

### WPE (TODO)

Not measured yet.

### Android shared-runtime WebView (TODO)

Not measured yet. Android shares the Player Runtime through the
`shared-runtime` assets and `WebViewCoreRenderer`; only the sandbox
measurement is outstanding.

## Production follow-ups (not spike blockers)

- Build the frame bootstrap as a real frame entry so both sides share
  the SDK event and revision helpers; the spike inlines a template.
- Decide the 5c bundle module format (classic vs ESM, SDK linkage).
- Track input revisions in the frame so slow elements cannot misreport
  after an update.
- Measure a `csp` attribute on the frame (`connect-src 'none'` with an
  `img-src`/`media-src` allowlist) after the core isolation result.
- Confirm blob-URL revocation timing against frame teardown on WPE.
