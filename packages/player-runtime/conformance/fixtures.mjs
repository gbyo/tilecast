/**
 * The Player Runtime conformance fixtures. Each one is a deterministic script
 * of host messages, clock steps and checkpoints; every engine runner plays
 * the same script and the results are compared checkpoint by checkpoint.
 *
 * Checkpoints marked `visual` are also compared as screenshots. Active video
 * and remote web content are never pixel-compared.
 */

const WALL = "2026-09-01T16:00:00.000Z";
const VIEWPORT = { width: 1280, height: 720 };

const item = (id, overrides = {}) => ({
  id,
  kind: "image",
  src: "",
  durationMs: 10_000,
  fitMode: "contain",
  audioEnabled: false,
  volume: 1,
  videoStartOffsetMs: null,
  videoEndOffsetMs: null,
  ...overrides,
});

/** Half of a 1920 × 1080 Span canvas, unrotated. */
const panel = (x) => ({
  x,
  y: 0,
  width: 960,
  height: 1080,
  rotation: 0,
  order: x === 0 ? 1 : 2,
  canvasWidth: 1920,
  canvasHeight: 1080,
});

const activation = (n) => ({
  activationId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  generation: n,
});

const playing = (items, extra = {}) => ({
  state: "playing",
  items,
  generation: 1,
  takeover: false,
  synchronized: false,
  ...extra,
});

const text = (value, style = {}) => ({
  t: "text",
  value,
  style: { fontFamily: "Tilecast UI", ...style },
});

/** The one stable current-widget compatibility fixture. */
const compatWidget = {
  background: "#101826",
  root: {
    t: "box",
    style: {
      direction: "column",
      justify: "center",
      align: "center",
      gap: 24,
      padding: 48,
    },
    children: [
      text("Tilecast Widget", {
        fontSize: 64,
        fontWeight: 700,
        color: "#F5F7FA",
      }),
      {
        t: "box",
        style: { direction: "row", gap: 32, align: "center" },
        children: [
          {
            t: "shape",
            shape: "circle",
            style: { fill: "#4C8BF5", width: 120, height: 120 },
          },
          {
            t: "chart",
            chart: "bar",
            series: [3, 7, 4, 9, 6],
            colors: ["#4C8BF5", "#F59E0B", "#10B981"],
          },
        ],
      },
      { t: "progress", ratio: 0.62, color: "#10B981", track: "#1F2937" },
      { t: "divider", color: "#334155" },
      text("Compatibility render tree", { fontSize: 28, color: "#94A3B8" }),
    ],
  },
};

const layout = {
  canvasWidth: 1920,
  canvasHeight: 1080,
  background: "#0B1220",
  zones: [
    {
      id: "zone-title",
      x: 80,
      y: 60,
      width: 1760,
      height: 160,
      layer: 1,
      opacity: 1,
      render: {
        t: "box",
        style: {
          direction: "row",
          align: "center",
          justify: "start",
          background: "#1E293B",
          padding: 24,
          radius: 12,
        },
        children: [
          text("Layout zones", {
            fontSize: 72,
            fontWeight: 700,
            color: "#F8FAFC",
          }),
        ],
      },
    },
    {
      id: "zone-image",
      x: 80,
      y: 280,
      width: 1000,
      height: 562,
      layer: 1,
      opacity: 1,
      radius: 16,
      image: { src: "media:landscape", fit: "cover" },
    },
    {
      id: "zone-rotation",
      x: 1140,
      y: 280,
      width: 700,
      height: 700,
      layer: 1,
      opacity: 1,
      playlistItems: [
        {
          id: "z1",
          kind: "image",
          src: "media:square",
          durationMs: 5_000,
          fit: "contain",
          muted: true,
          volume: 1,
          loop: false,
        },
        {
          id: "z2",
          kind: "image",
          src: "media:portrait",
          durationMs: 5_000,
          fit: "contain",
          muted: true,
          volume: 1,
          loop: false,
        },
      ],
    },
    {
      id: "zone-empty",
      x: 80,
      y: 900,
      width: 400,
      height: 100,
      layer: 1,
      opacity: 1,
    },
  ],
};

const countdown = {
  id: "cd-1",
  type: "countdown_bar",
  version: 1,
  config: {
    message: "Lunch starts in",
    scheduleType: "one_time",
    oneTimeAt: "2026-09-01T16:10:00.000Z",
    timezone: "UTC",
    leadTimeSeconds: 3_600,
    completionText: "Lunch time",
    showConfetti: true,
    displayMode: "overlay",
    heightPx: 72,
    progressFill: "drain",
    priority: 1,
  },
};

const ticker = {
  id: "alert-1",
  type: "alert_ticker",
  version: 1,
  config: {
    message: "Severe weather warning in effect until 18:00. Stay indoors.",
    severity: "warning",
    displayMode: "push",
    heightPx: 96,
    speed: "medium",
    priority: 10,
    expiresAt: "2026-09-01T18:00:00.000Z",
  },
};

const brandBug = {
  id: "bug-1",
  type: "brand_bug",
  version: 1,
  config: {
    corner: "top_right",
    text: "Tilecast Academy",
    widthPercent: 14,
    textSizePercent: 3,
    opacityPercent: 90,
    marginPercent: 3,
    textColor: "#FFFFFF",
    backgroundStyle: "scrim",
    priority: 1,
  },
};

const noiseMeter = {
  id: "noise-1",
  type: "noise_meter",
  version: 1,
  config: {
    message: "Too loud",
    warningLevel: 60,
    loudLevel: 80,
    sensitivity: 50,
    triggerHoldMs: 0,
    clearHoldMs: 0,
    displayMode: "overlay",
    heightPx: 96,
  },
};

export const fixtures = [
  {
    name: "setup",
    description:
      "Unpaired installation: manual server entry and a discovered server.",
    steps: [
      { present: { presentation: { state: "setup" } } },
      {
        discovered: {
          name: "Tilecast",
          serverUrl: "https://signage.example.org",
        },
      },
      { checkpoint: "setup", visual: true },
    ],
  },
  {
    name: "pairing",
    description: "Pairing code while approval is pending.",
    steps: [
      {
        present: {
          presentation: {
            state: "pairing",
            code: "K7Q2XD",
            approvalUrl: "https://signage.example.org/screens/pair",
            organizationName: "Greenwood Schools",
          },
          activation: activation(1),
        },
      },
      { checkpoint: "pairing", visual: true },
    ],
  },
  {
    name: "status-surfaces",
    description: "Idle, disabled, offline and safe-mode surfaces.",
    steps: [
      {
        present: {
          presentation: {
            state: "idle",
            title: "Greenwood Schools",
            message: "No content assigned.",
            backgroundColor: "#0E141B",
            textColor: "#F5F7FA",
            footerText: "Tilecast",
          },
          activation: activation(1),
        },
      },
      { checkpoint: "idle", visual: true },
      {
        present: {
          presentation: {
            state: "unavailable",
            title: "Content unavailable",
            message: "Assigned content is not currently available.",
            status: "server_unreachable",
            backgroundColor: "#1B1020",
            textColor: "#FDE68A",
          },
          activation: activation(2),
        },
      },
      { checkpoint: "offline", visual: true },
      {
        present: {
          presentation: {
            state: "disabled",
            title: "Screen disabled",
            message: "An administrator disabled this screen.",
          },
          activation: activation(3),
        },
      },
      { checkpoint: "disabled", visual: true },
      {
        present: {
          presentation: {
            state: "safe-mode",
            reason: "The renderer restarted too often.",
          },
          activation: activation(4),
        },
      },
      { checkpoint: "safe-mode", visual: true },
    ],
  },
  {
    name: "image-fit",
    description: "Image contain, cover and fill.",
    steps: [
      {
        present: {
          presentation: playing([
            item("contain-landscape", { src: "media:landscape" }),
          ]),
          activation: activation(1),
        },
      },
      { checkpoint: "contain-landscape", visual: true },
      {
        present: {
          presentation: playing([
            item("contain-portrait", { src: "media:portrait" }),
          ]),
          activation: activation(2),
        },
      },
      { checkpoint: "contain-portrait", visual: true },
      {
        present: {
          presentation: playing([
            item("cover-portrait", { src: "media:portrait", fitMode: "cover" }),
          ]),
          activation: activation(3),
        },
      },
      { checkpoint: "cover-portrait", visual: true },
      {
        present: {
          presentation: playing([
            item("fill-portrait", { src: "media:portrait", fitMode: "fill" }),
          ]),
          activation: activation(4),
        },
      },
      { checkpoint: "fill-portrait", visual: true },
    ],
  },
  {
    name: "playlist-transitions",
    description: "A three-item rotation with fade and cut transitions.",
    steps: [
      {
        present: {
          presentation: playing([
            item("a", {
              src: "media:landscape",
              durationMs: 5_000,
              transition: "fade",
            }),
            item("b", {
              src: "media:square",
              durationMs: 5_000,
              transition: "none",
            }),
            item("c", {
              src: "media:portrait",
              durationMs: 5_000,
              transition: "crossfade",
            }),
          ]),
          activation: activation(1),
        },
      },
      { checkpoint: "first", visual: true },
      { advance: 5_000 },
      { checkpoint: "second", visual: true },
      { advance: 5_000 },
      { checkpoint: "third" },
      { advance: 5_000 },
      { checkpoint: "wrapped" },
      { command: "skip-item" },
      { advance: 0 },
      { checkpoint: "skipped" },
    ],
  },
  {
    name: "video",
    video: true,
    description:
      "Video lifecycle: first frame, progress evidence and end offset.",
    steps: [
      {
        present: {
          presentation: playing([
            item("clip", {
              kind: "video",
              src: "media:clip",
              durationMs: null,
              videoEndOffsetMs: 1_500,
            }),
            item("after", { src: "media:square" }),
          ]),
          activation: activation(1),
        },
      },
      { waitForEvidence: { kind: "video-progress", itemId: "clip" } },
      { checkpoint: "playing" },
      // The end offset completes the item on the media's own clock; the
      // one-task hand-off to the next item then runs on the manual clock.
      {
        waitForEvidence: {
          kind: "item-transition",
          itemId: "clip",
          timeoutMs: 20_000,
        },
      },
      { advance: 0 },
      { checkpoint: "advanced", visual: true },
    ],
  },
  {
    name: "synchronized",
    // Needs a feature the pre-migration bridge did not have, or a long real-time run.
    legacy: false,
    description:
      "A synchronized group joins mid-cycle and follows the shared timeline.",
    steps: [
      {
        present: {
          presentation: playing(
            [
              item("s1", { src: "media:landscape" }),
              item("s2", { src: "media:square" }),
              item("s3", { src: "media:portrait" }),
            ],
            { synchronized: true },
          ),
          activation: activation(1),
          timing: {
            groupId: "group-1",
            anchorMs: Date.parse(WALL) - 14_000,
            durationsMs: [10_000, 10_000, 10_000],
            clockOffsetMs: 0,
          },
        },
      },
      { checkpoint: "joined", visual: true },
      { stepWall: -3_600_000 },
      { advance: 5_990 },
      { checkpoint: "before-boundary" },
      { advance: 20 },
      { checkpoint: "after-boundary", visual: true },
      { command: "skip-item" },
      { checkpoint: "skip-ignored" },
    ],
  },
  {
    name: "span",
    description:
      "Span panels: one image cropped to the left and right panels of a two-panel canvas, and a Layout background cropped to a panel.",
    steps: [
      {
        present: {
          presentation: playing([
            item("span-left", {
              src: "media:landscape",
              fitMode: "cover",
              viewport: panel(0),
            }),
          ]),
          activation: activation(1),
        },
      },
      { checkpoint: "left-panel", visual: true },
      {
        present: {
          presentation: playing([
            item("span-right", {
              src: "media:landscape",
              fitMode: "cover",
              viewport: panel(960),
            }),
          ]),
          activation: activation(2),
        },
      },
      { checkpoint: "right-panel", visual: true },
      {
        present: {
          presentation: playing([
            item("span-layout", {
              kind: "layout",
              durationMs: null,
              layout: {
                canvasWidth: 960,
                canvasHeight: 1080,
                background: "#0B1220",
                backgroundImage: "media:landscape",
                backgroundImageViewport: {
                  x: 960,
                  y: 0,
                  width: 960,
                  height: 1080,
                  canvasWidth: 1920,
                  canvasHeight: 1080,
                },
                zones: [],
              },
            }),
          ]),
          activation: activation(3),
        },
      },
      { checkpoint: "layout-panel", visual: true },
    ],
  },
  {
    name: "layout",
    description:
      "Layout zones: render tree, image, rotating playlist and an empty zone.",
    steps: [
      {
        present: {
          presentation: playing([
            item("layout-1", { kind: "layout", durationMs: null, layout }),
          ]),
          activation: activation(1),
        },
      },
      { checkpoint: "layout", visual: true },
      { advance: 5_000 },
      { checkpoint: "zone-rotated", visual: true },
    ],
  },
  {
    name: "widget-compat",
    description: "The stable current-widget compatibility fixture.",
    steps: [
      {
        present: {
          presentation: playing([
            item("widget-1", {
              kind: "widget",
              durationMs: null,
              widget: compatWidget,
            }),
          ]),
          activation: activation(1),
        },
      },
      { checkpoint: "widget", visual: true },
      { advance: 30_000 },
      { checkpoint: "widget-alive" },
    ],
  },
  {
    name: "outside-hours",
    description:
      "Outside active hours: custom text, the bouncing logo and black.",
    steps: [
      {
        present: {
          presentation: {
            state: "sleep",
            display: "custom_text",
            text: "See you tomorrow",
            textColor: "#F5F7FA",
          },
          activation: activation(1),
        },
      },
      { checkpoint: "custom-text", visual: true },
      {
        present: {
          presentation: { state: "sleep", display: "bouncing_logo" },
          activation: activation(2),
        },
      },
      { checkpoint: "bouncing-logo", visual: true },
      {
        present: {
          presentation: { state: "sleep", display: "black" },
          activation: activation(3),
        },
      },
      { checkpoint: "black", visual: true },
    ],
  },
  {
    name: "takeover",
    // Needs a feature the pre-migration bridge did not have, or a long real-time run.
    legacy: false,
    description:
      "A takeover interrupts playback and the schedule resumes after it.",
    steps: [
      {
        present: {
          presentation: playing([
            item("sched-a", { src: "media:landscape" }),
            item("sched-b", { src: "media:square" }),
          ]),
          activation: activation(1),
        },
      },
      { checkpoint: "scheduled" },
      { advance: 4_000 },
      {
        present: {
          presentation: playing(
            [item("takeover", { src: "media:portrait", durationMs: null })],
            { takeover: true },
          ),
          activation: activation(2),
        },
      },
      { checkpoint: "takeover", visual: true },
      { advance: 60_000 },
      { checkpoint: "takeover-holds" },
      {
        present: {
          presentation: playing([
            item("sched-a", { src: "media:landscape" }),
            item("sched-b", { src: "media:square" }),
          ]),
          activation: activation(3),
        },
      },
      { checkpoint: "resumed" },
    ],
  },
  {
    name: "plugins",
    description:
      "Countdown bar, emergency ticker priority and a brand bug over content.",
    steps: [
      {
        present: {
          presentation: playing([
            item("under", { src: "media:square", durationMs: null }),
          ]),
          activation: activation(1),
        },
      },
      { plugins: { plugins: [countdown, brandBug] } },
      { advance: 0 },
      { checkpoint: "countdown", visual: true },
      { plugins: { plugins: [countdown, brandBug, ticker] } },
      { advance: 0 },
      { checkpoint: "ticker-wins", visual: true },
      { plugins: { plugins: [brandBug] } },
      { advance: 1_000 },
      { checkpoint: "cleared", visual: true },
    ],
  },
  {
    name: "noise-meter",
    // Needs a feature the pre-migration bridge did not have, or a long real-time run.
    legacy: false,
    description: "Host-measured noise levels take the strip and release it.",
    steps: [
      {
        present: {
          presentation: playing([
            item("room", { src: "media:landscape", durationMs: null }),
          ]),
          activation: activation(1),
        },
      },
      { plugins: { plugins: [noiseMeter, countdown] } },
      { noise: 0.9 },
      { advance: 100 },
      { noise: 0.9 },
      { advance: 100 },
      { checkpoint: "loud" },
      { noise: 0.0 },
      { advance: 100 },
      { noise: 0.0 },
      { advance: 1_000 },
      { checkpoint: "quiet" },
    ],
  },
  {
    name: "identify",
    description: "The identify overlay over content, then gone.",
    steps: [
      {
        present: {
          presentation: playing([
            item("under", { src: "media:landscape", durationMs: null }),
          ]),
          activation: activation(1),
        },
      },
      { identify: { name: "Library Lobby", durationSeconds: 10 } },
      { checkpoint: "identify", visual: true },
      { advance: 10_000 },
      { checkpoint: "identify-gone" },
    ],
  },
  {
    name: "projection-rejected",
    // Needs a feature the pre-migration bridge did not have, or a long real-time run.
    legacy: false,
    description:
      "A widget reference without a projection context is rejected, not shown partially.",
    steps: [
      {
        present: {
          presentation: playing([
            item("ok", { src: "media:square", durationMs: null }),
          ]),
          activation: activation(1),
        },
      },
      {
        present: {
          presentation: playing([
            item("ref", {
              kind: "widget",
              widget: { widgetAssetId: "missing" },
            }),
          ]),
          activation: activation(2),
        },
      },
      { checkpoint: "kept-previous" },
    ],
  },
].map((fixture) => ({ wallClock: WALL, viewport: VIEWPORT, ...fixture }));
