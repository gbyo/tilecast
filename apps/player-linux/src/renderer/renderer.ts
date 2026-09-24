/**
 * Tilecast Player renderer — the display surface.
 *
 * Receives complete presentations from the main process and rotates through
 * playlist items on two crossfading layers. It reports real playback
 * progress (item transitions, advancing video time, re-shown images, healthy
 * websites) so the supervisor judges health by what is actually on screen.
 * A failing item is isolated: it reports an error and the rotation advances,
 * never wedging the loop.
 *
 * Compiled as a plain global script — no module syntax — so it runs in the
 * sandboxed page directly.
 */

// Minimal local mirror of the render-tree IR (core/render-tree.ts). The
// renderer is a dependency-free browser script, so the shape is duplicated
// here rather than imported; it is a dumb interpreter with no data logic.
interface AnyNode {
  t: string;
  [key: string]: unknown;
}

interface WidgetPayload {
  background: string;
  root: AnyNode;
  autoSkip?: boolean;
}

interface LayoutZonePayload {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  opacity: number;
  radius?: number;
  render?: AnyNode;
  image?: { src: string; fit: string };
  playlistItems?: {
    id: string;
    kind: "image" | "video";
    src: string;
    durationMs: number | null;
    fit: string;
    muted: boolean;
    volume: number;
    loop: boolean;
  }[];
}

interface LayoutPayload {
  canvasWidth: number;
  canvasHeight: number;
  background: string;
  backgroundImage?: string;
  backgroundImageViewport?: {
    x: number;
    y: number;
    width: number;
    height: number;
    canvasWidth: number;
    canvasHeight: number;
  };
  zones: LayoutZonePayload[];
}

interface RendererViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  order: number;
  canvasWidth: number;
  canvasHeight: number;
}

interface RendererItem {
  id: string;
  kind: "image" | "video" | "website" | "widget" | "layout" | "youtube";
  src: string;
  durationMs: number | null;
  fitMode: string;
  transition?: string;
  audioEnabled: boolean;
  volume: number;
  videoStartOffsetMs: number | null;
  videoEndOffsetMs: number | null;
  viewport?: RendererViewport;
  website?: {
    loadTimeoutSeconds: number;
    refreshIntervalSeconds: number | null;
    zoomPercent: number;
    javascriptEnabled: boolean;
    domStorageEnabled: boolean;
    cookiePolicy: string;
    reloadPolicy: string;
    customUserAgent: string;
    scrollX: number;
    scrollY: number;
    backgroundColor: string;
    failureBehavior: string;
    fallbackSrc: string | null;
    allowedHosts: string[];
  };
  widget?: WidgetPayload;
  layout?: LayoutPayload;
}

interface RendererPresentation {
  state: string;
  items?: RendererItem[];
  generation?: number;
  /**
   * True when a group's shared timeline owns occurrence changes. The renderer
   * then reports progress and renders what it is given, but never advances the
   * playlist itself.
   */
  synchronized?: boolean;
  takeover?: boolean;
  code?: string;
  approvalUrl?: string;
  organizationName?: string;
  title?: string;
  message?: string;
  backgroundColor?: string;
  textColor?: string;
  logoSrc?: string | null;
  footerText?: string;
  status?: string;
  reason?: string;
  provider?: string;
  sessionId?: string;
  receiverName?: string;
  pin?: string;
  expiresAt?: string;
  connected?: boolean;
  role?: string;
  transport?: string;
  audioMode?: string;
  /**
   * Presentation Network progress for the AirPlay ready page. Deliberately just a
   * phase: the network's name, its SSID, and its credential never reach the TV.
   */
  presentationNetwork?: "joining" | "connected" | "failed";
}

interface TilecastBridge {
  onPresent(callback: (presentation: RendererPresentation) => void): void;
  onPlugins(
    callback: (payload: {
      plugins: RendererPlugin[];
      clockOffsetMs: number;
    }) => void,
  ): void;
  onIdentify(
    callback: (data: { name: string; durationSeconds: number }) => void,
  ): void;
  onRetryItem(callback: () => void): void;
  onSkipItem(callback: () => void): void;
  /** `zoneId` identifies which layout zone produced the evidence. */
  reportProgress(itemId: string | null, kind: string, zoneId?: string): void;
  reportPlaybackError(itemId: string | null, message: string): void;
  /**
   * The Noise Meter's only channel out of the renderer. It carries a diagnostic
   * string, never a level, a sample, or anything derived from the audio itself.
   */
  reportNoiseMeterDiagnostic(
    message: string,
    detail?: Record<string, unknown>,
  ): void;
  /**
   * The Noise Meter's state and, once every ten seconds, one completed
   * aggregate. Derived numbers only: the stream, the analyser, and every sample
   * stay in this renderer.
   */
  reportNoiseMeter(report: {
    status: string;
    level?: number | null;
    bucket?: TilecastNoiseHistoryBucket | null;
  }): void;
  reportWebsiteRecovered(): void;
  submitServerUrl(url: string): Promise<{ ok: boolean; error?: string }>;
  onDiscoveredServer(
    callback: (server: { name: string; serverUrl: string }) => void,
  ): void;
  listDiscoveredServers(): Promise<{ name: string; serverUrl: string }[]>;
}

interface RendererCountdownBarPlugin {
  id: string;
  type: "countdown_bar";
  version: 1;
  config: {
    message: string;
    scheduleType: "weekly" | "one_time";
    targetTime?: string | null;
    daysOfWeek?: number[];
    oneTimeAt?: string | null;
    timezone: string;
    leadTimeSeconds: number;
    completionText?: string;
    showConfetti?: boolean;
    displayMode: "overlay" | "push";
    heightPx: number;
    /** These fields are absent on manifests published before they existed. */
    progressFill?: "none" | "drain" | null;
    contentPadding?: number | null;
    textScale?: number | null;
    priority: number;
  };
}

interface RendererAlertTickerPlugin {
  id: string;
  type: "alert_ticker";
  version: 1;
  config: {
    name?: string;
    message: string;
    severity?: string;
    event?: string;
    displayMode: "overlay" | "push";
    heightPx: number;
    speed: "slow" | "medium" | "fast";
    priority: number;
    expiresAt: string;
  };
}

interface RendererBrandBugPlugin {
  id: string;
  type: "brand_bug";
  version: 1;
  config: {
    name?: string;
    corner: string;
    imageAssetId?: string | null;
    imageVariantId?: string | null;
    text?: string;
    widthPercent: number;
    textSizePercent: number;
    opacityPercent: number;
    marginPercent: number;
    textColor: string;
    backgroundStyle: string;
    startsAt?: string | null;
    endsAt?: string | null;
    priority: number;
  };
}

interface RendererNoiseMeterPlugin {
  id: string;
  type: "noise_meter";
  version: 1;
  config: {
    name?: string;
    message?: string;
    warningLevel: number;
    loudLevel: number;
    sensitivity: number;
    triggerHoldMs: number;
    clearHoldMs: number;
    displayMode: "overlay" | "push";
    heightPx: number;
    historyEnabled?: boolean;
    historyRetentionDays?: number;
    historyActiveHoursOnly?: boolean;
    scheduleEnabled?: boolean;
    scheduleDaysOfWeek?: number[];
    scheduleStartTime?: string | null;
    scheduleEndTime?: string | null;
    scheduleTimezone?: string;
  };
}

type RendererPlugin =
  | RendererCountdownBarPlugin
  | RendererAlertTickerPlugin
  | RendererBrandBugPlugin
  | RendererNoiseMeterPlugin;

declare const tilecast: TilecastBridge;

const layerA = document.getElementById("layer-a") as HTMLDivElement;
const layerB = document.getElementById("layer-b") as HTMLDivElement;
const messageEl = document.getElementById("message") as HTMLDivElement;
const identifyEl = document.getElementById("identify") as HTMLDivElement;
const contentStage = document.getElementById("content-stage") as HTMLDivElement;
const countdownBar = document.getElementById("countdown-bar") as HTMLDivElement;
const countdownMessage = countdownBar.querySelector(
  ".countdown-message",
) as HTMLSpanElement;
const countdownValue = countdownBar.querySelector(
  ".countdown-value",
) as HTMLSpanElement;
const countdownFill = countdownBar.querySelector(
  ".countdown-fill",
) as HTMLSpanElement;
const countdownUrgency = countdownBar.querySelector(
  ".countdown-urgency",
) as HTMLSpanElement;
const countdownConfetti = document.getElementById(
  "countdown-confetti",
) as HTMLDivElement;
const alertTickerBar = document.getElementById(
  "alert-ticker",
) as HTMLDivElement;
const alertTickerSeverity = alertTickerBar.querySelector(
  ".ticker-severity",
) as HTMLSpanElement;
const alertTickerViewport = alertTickerBar.querySelector(
  ".ticker-viewport",
) as HTMLSpanElement;
const alertTickerTrack = alertTickerBar.querySelector(
  ".ticker-track",
) as HTMLSpanElement;
const alertTickerText = alertTickerBar.querySelector(
  ".ticker-message",
) as HTMLSpanElement;
const brandBugLayer = document.getElementById("brand-bugs") as HTMLDivElement;
const noiseMeterBar = document.getElementById("noise-meter") as HTMLDivElement;
const noiseMeterMarker = noiseMeterBar.querySelector(
  ".noise-meter__marker",
) as HTMLSpanElement;
const noiseMeterWarning = noiseMeterBar.querySelector(
  ".noise-meter__warning",
) as HTMLSpanElement;

let frontLayer = layerA;
let backLayer = layerB;

let items: RendererItem[] = [];
let generation = -1;
let index = 0;
let itemTimer: number | null = null;
let stillImageTicker: number | null = null;
let websiteRefreshTimer: number | null = null;
let websiteLoadTimer: number | null = null;
let advanceTimer: number | null = null;
let failTimer: number | null = null;
let currentItem: RendererItem | null = null;
let consecutiveFailures = 0;
let consecutiveEmptySkips = 0;
/** Who may change the current playlist occurrence — see playback-policy.ts. */
let playbackAuthority: PlaybackAuthority = "local";
/** Bumped for every mounted item so delayed callbacks can detect staleness. */
let renderToken = 0;
let completion = new ItemCompletion("local", false);
/** Teardowns for independently-rotating layout zones of the current item. */
let zoneTeardowns: (() => void)[] = [];
let activeTransition = "fade";

/** The fade duration in static/index.html; two decoders overlap for it. */
const CROSSFADE_MS = 300;
const LAYER_CLEANUP_MS = 500;

// Each fill of a layer gets a number, so delayed cleanup can tell "the layer I
// faded out" from "that same layer, since refilled for the next item".
const layerFills = new WeakMap<HTMLDivElement, number>();
let fillSequence = 0;

function layerFill(layer: HTMLDivElement): number {
  return layerFills.get(layer) ?? 0;
}

function playbackToken(): PlaybackToken {
  return { generation, render: renderToken };
}

function stillCurrent(captured: PlaybackToken): boolean {
  return isCurrentPlayback(captured, playbackToken());
}

const FIT_MODES: Record<string, string> = {
  contain: "contain",
  fit: "contain",
  cover: "cover",
  fill: "fill",
  stretch: "fill",
};

function clearTimers(): void {
  if (itemTimer !== null) {
    window.clearTimeout(itemTimer);
    itemTimer = null;
  }
  if (stillImageTicker !== null) {
    window.clearInterval(stillImageTicker);
    stillImageTicker = null;
  }
  if (websiteRefreshTimer !== null) {
    window.clearInterval(websiteRefreshTimer);
    websiteRefreshTimer = null;
  }
  if (websiteLoadTimer !== null) {
    window.clearTimeout(websiteLoadTimer);
    websiteLoadTimer = null;
  }
  if (advanceTimer !== null) {
    window.clearTimeout(advanceTimer);
    advanceTimer = null;
  }
  // A failure back-off that has not fired yet belongs to the item that failed;
  // letting it fire later would advance past whatever is on screen by then.
  if (failTimer !== null) {
    window.clearTimeout(failTimer);
    failTimer = null;
  }
  clearZoneTeardowns();
  clearNodeTimers();
}

function clearZoneTeardowns(): void {
  const teardowns = zoneTeardowns;
  zoneTeardowns = [];
  for (const teardown of teardowns) {
    teardown();
  }
}

/** Stop decoders on a layer that is no longer visible. */
function pauseLayerVideos(layer: HTMLElement): void {
  for (const video of Array.from(layer.querySelectorAll("video"))) {
    video.pause();
  }
}

/**
 * Stage the next item on the hidden layer. Detaching a still-playing <video>
 * leaves it decoding into a VA-API surface nobody can see, so the layer's
 * current content is stopped first.
 */
function fillBackLayer(node: Node): void {
  pauseLayerVideos(backLayer);
  fillSequence += 1;
  layerFills.set(backLayer, fillSequence);
  backLayer.replaceChildren(node);
}

function swapLayers(): void {
  const outgoing = frontLayer;
  frontLayer = backLayer;
  backLayer = outgoing;
  const transition =
    activeTransition === "none" ? "none" : "opacity 300ms ease";
  frontLayer.style.transition = transition;
  outgoing.style.transition = transition;
  frontLayer.classList.add("visible");
  outgoing.classList.remove("visible");

  // Capture the layer and its fill now. Reading the mutable `backLayer` inside
  // the delayed callbacks would tear down whatever happened to be in the back
  // at that moment — including a layer already refilled for the next item.
  const capturedFill = layerFill(outgoing);
  const state = () => ({
    outgoingIsFront: outgoing === frontLayer,
    capturedFill,
    currentFill: layerFill(outgoing),
  });

  // Two fullscreen decoders may overlap for the fade and no longer: on Intel
  // Gen7 with VA-API and a single-fullscreen overlay, that contention is what
  // makes a switch stutter or trip out. Pausing only once the incoming layer is
  // fully opaque means the frame left behind is frozen, never black — and with
  // no fade to wait for, the incoming layer is already opaque, so the outgoing
  // decoder is released on the next task instead of holding the GPU for the
  // length of a transition that is not running.
  window.setTimeout(
    () => {
      if (shouldPauseOutgoingLayer(state())) {
        pauseLayerVideos(outgoing);
      }
    },
    activeTransition === "none" ? 0 : CROSSFADE_MS + 20,
  );
  // Free decoders/webviews shortly after the fade completes.
  window.setTimeout(() => {
    if (shouldClearOutgoingLayer(state())) {
      outgoing.replaceChildren();
    }
  }, LAYER_CLEANUP_MS);
}

function showMessage(html: string): void {
  clearTimers();
  currentItem = null;
  playbackAuthority = "local";
  messageEl.style.background = "";
  messageEl.style.color = "";
  messageEl.innerHTML = html;
  messageEl.classList.add("visible");
  layerA.classList.remove("visible");
  layerB.classList.remove("visible");
  pauseLayerVideos(layerA);
  pauseLayerVideos(layerB);
  layerA.replaceChildren();
  layerB.replaceChildren();
}

function showBrandedMessage(presentation: RendererPresentation): void {
  showMessage("");
  const background = /^#[0-9a-fA-F]{6}$/.test(
    presentation.backgroundColor ?? "",
  )
    ? presentation.backgroundColor!
    : "#0E141B";
  const text = /^#[0-9a-fA-F]{6}$/.test(presentation.textColor ?? "")
    ? presentation.textColor!
    : "#F5F7FA";
  messageEl.style.background = background;
  messageEl.style.color = text;
  const logo = presentation.logoSrc
    ? `<img class="branded-fallback__logo" src="${escapeHtml(presentation.logoSrc)}" alt="" />`
    : "";
  const footer = presentation.footerText
    ? `<p class="branded-fallback__footer">${escapeHtml(presentation.footerText)}</p>`
    : "";
  const status = presentation.status
    ? `<p class="branded-fallback__status">${escapeHtml(presentation.status.replaceAll("_", " "))}</p>`
    : "";
  messageEl.innerHTML = `<div class="branded-fallback">${logo}<h1>${escapeHtml(presentation.title ?? "")}</h1><p>${escapeHtml(presentation.message ?? "")}</p>${status}${footer}</div>`;
}

function hideMessage(): void {
  messageEl.classList.remove("visible");
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

// ------------------------------------------------ built-in plugin surfaces
//
// This channel never calls present(), fills a layer, changes generation, or
// touches playback timers. A bar can therefore appear, tick, change mode, and
// disappear while the exact same media element or Layout remains mounted.
let pluginTimer: number | null = null;
let activePlugins: RendererPlugin[] = [];
let pluginClockOffsetMs = 0;
let lastConfettiKey = "";

// The Noise Meter is the one plugin surface that measures something, so it
// carries state between ticks: the applicable instance, its microphone, the
// smoothed level, and where the hysteresis has got to. All four are torn down
// when no instance applies.
let noiseMeterSettings: TilecastNoiseMeterSettings | null = null;
let noiseMeterMachine: TilecastNoiseMeterMachine | null = null;
let noiseMeterCapture: TilecastNoiseMeterCapture | null = null;
const noiseMeterSmoother = tilecastNoiseMeter.createSmoother();
let noiseMeterReading: TilecastNoiseMeterReading = {
  state: "unavailable",
  visible: false,
  level: 0,
};
let noiseHistory: TilecastNoiseHistoryAggregator | null = null;
/**
 * Whether the screen is inside its configured active hours. `sleep` is the
 * player's own canonical off-hours state, so the meter follows it rather than
 * evaluating a second copy of the schedule.
 */
let playerAwake = true;
/**
 * Whether the display window was open at the last tick. A window opens and
 * closes on the clock with nothing else to announce it, so the one-second
 * plugin tick is what notices and reconciles the microphone.
 */
let noiseWindowWasOpen = true;
/** Reported state, so a change is sent immediately rather than at the next bucket. */
let lastReportedNoiseStatus = "";

function triggerCountdownConfetti(
  selected: TilecastActiveCountdownBar | null,
): void {
  if (!selected?.showConfetti) return;
  const key = `${selected.id}:${selected.targetAt}`;
  if (key === lastConfettiKey) return;
  lastConfettiKey = key;
  countdownConfetti.replaceChildren();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#F7C948", "#F45B69", "#4CC9F0", "#7BD389", "#A78BFA"];
  let seed = Array.from(key).reduce(
    (value, character) =>
      Math.imul(value ^ character.charCodeAt(0), 16_777_619) >>> 0,
    2_166_136_261,
  );
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  for (let index = 0; index < 220; index += 1) {
    const piece = document.createElement("span");
    piece.className = "countdown-confetti__piece";
    piece.style.setProperty("--confetti-x", `${random() * 100}%`);
    piece.style.setProperty("--confetti-drift", `${random() * 28 - 14}vw`);
    piece.style.setProperty("--confetti-spin", `${540 + random() * 1_080}deg`);
    piece.style.setProperty("--confetti-delay", `${random() * 3.8}s`);
    piece.style.setProperty("--confetti-duration", `${5 + random() * 2}s`);
    piece.style.setProperty(
      "--confetti-color",
      colors[index % colors.length] ?? "#F7C948",
    );
    piece.style.setProperty("--confetti-width", `${14 + random() * 14}px`);
    piece.style.setProperty("--confetti-height", `${20 + random() * 20}px`);
    piece.style.setProperty(
      "--confetti-radius",
      random() > 0.75 ? "50%" : "2px",
    );
    countdownConfetti.append(piece);
  }
  window.setTimeout(() => {
    if (lastConfettiKey === key) countdownConfetti.replaceChildren();
  }, 11_500);
}

/**
 * The bar slot holds one bar, and three surfaces can want it. An emergency
 * ticker takes it whenever one is active: a Countdown Bar counting down to
 * lunch must never be what a screen is showing instead of a tornado warning. A
 * room that is too loud comes next, and the countdown last. Nothing is lost by
 * losing the strip — each surface keeps resolving itself and returns the moment
 * the one above it stops — and playback is untouched throughout.
 */
function updatePluginSurface(): void {
  const now = new Date();
  // Each resolver owns one discriminator, so the manifest's mixed plugin array
  // is narrowed here rather than re-checked inside every one of them.
  // Corner marks are independent of the bar slot: they are resolved once and
  // then applied on whichever branch below decides what holds the strip.
  const marks = tilecastBrandBug.resolve(
    activePlugins.filter(
      (plugin): plugin is RendererBrandBugPlugin => plugin.type === "brand_bug",
    ),
    now,
    pluginClockOffsetMs,
  );
  const ticker = tilecastAlertTicker.resolve(
    activePlugins,
    now,
    pluginClockOffsetMs,
  );
  // The noise meter runs on its own faster loop; what is read here is only
  // whether it currently wants the strip. A configured display window is the
  // other half of that question: outside it the room is still measured, and
  // the bar simply does not appear.
  const windowOpen = noiseMeterWindowOpen(now);
  if (noiseMeterSettings !== null && windowOpen !== noiseWindowWasOpen) {
    // Set first: applying the lifecycle re-enters this function, and a second
    // pass must see the state it is reconciling to rather than loop.
    noiseWindowWasOpen = windowOpen;
    applyNoiseMeterLifecycle();
    return;
  }
  noiseWindowWasOpen = windowOpen;
  const meter =
    noiseMeterReading.visible && windowOpen ? noiseMeterSettings : null;
  const owner = tilecastNoiseMeter.stripOwner({
    alertTicker: ticker !== null,
    noiseMeter: meter !== null,
    countdownBar: true,
  });
  if (owner !== "noise_meter") {
    noiseMeterBar.classList.remove("visible");
    noiseMeterBar.classList.remove("noise-meter--entering");
  }
  if (ticker) {
    countdownBar.classList.remove("visible");
    countdownBar.classList.remove("countdown-pulse");
    showAlertTicker(ticker);
    // A ticker holds the same bottom strip a countdown bar would, so
    // bottom-corner marks ride above it rather than being covered by it.
    updateBrandBugs(marks, ticker.heightPx);
    return;
  }
  alertTickerBar.classList.remove("visible");
  activeTickerKey = "";
  if (owner === "noise_meter" && meter) {
    // A countdown is not destroyed by losing the strip: it is resolved from the
    // cached manifest every tick and returns as soon as the room is normal.
    countdownBar.classList.remove("visible");
    countdownBar.classList.remove("countdown-pulse");
    showNoiseMeter(meter);
    updateBrandBugs(marks, meter.heightPx);
    return;
  }
  // Schedule resolution lives in countdown-bar-resolver and brand-bug-resolver
  // so each surface and its unit tests share one implementation of the timezone,
  // window, and priority rules.
  const selected = tilecastCountdownBar.resolve(
    activePlugins.filter(
      (plugin): plugin is RendererCountdownBarPlugin =>
        plugin.type === "countdown_bar",
    ),
    now,
    pluginClockOffsetMs,
  );
  triggerCountdownConfetti(selected);
  // Confetti is triggered above rather than inside this branch: a completed
  // instance stops holding the strip but still owes its completion burst.
  if (!selected || !selected.showBar) {
    countdownBar.classList.remove("visible");
    countdownBar.classList.remove("countdown-pulse");
    contentStage.classList.remove("plugin-push");
  } else {
    document.documentElement.style.setProperty(
      "--plugin-height",
      `${selected.heightPx}px`,
    );
    // Padding and type size are resolved centrally so both players agree on what
    // a given contentPadding and textScale mean.
    document.documentElement.style.setProperty(
      "--plugin-bar-padding",
      `${selected.contentPadding}%`,
    );
    document.documentElement.style.setProperty(
      "--plugin-bar-font-size",
      `${selected.fontSizePx}px`,
    );
    contentStage.classList.toggle(
      "plugin-push",
      selected.displayMode === "push",
    );
    countdownMessage.textContent = selected.message;
    countdownValue.textContent = selected.value;
    countdownUrgency.textContent = selected.urgencyLabel;
    countdownBar.dataset.urgency = selected.urgencyStage;
    countdownBar.classList.toggle("countdown-pulse", selected.pulse);
    // A null fraction means this instance asked for no fill, so the width stays
    // at zero and the bar keeps its plain background.
    countdownFill.style.width =
      selected.remainingFraction === null
        ? "0"
        : `${selected.remainingFraction * 100}%`;
    countdownBar.classList.add("visible");
  }
  // A visible countdown bar owns the bottom strip, so bottom-corner marks ride
  // above it instead of being covered by it. A resolved instance that is past
  // its countdown holds no strip, so it lifts nothing.
  updateBrandBugs(marks, selected?.showBar ? selected.heightPx : 0);
}

interface BrandBugNode {
  root: HTMLDivElement;
  logo: HTMLImageElement;
  caption: HTMLSpanElement;
  signature: string;
}

/**
 * Corner marks are kept as long-lived elements keyed by corner. Rebuilding them
 * on the one-second plugin tick would restart the logo's decode and flicker a
 * watermark that is supposed to look painted on.
 */
const brandBugNodes = new Map<string, BrandBugNode>();

function updateBrandBugs(
  marks: TilecastActiveBrandBug[],
  bottomLiftPx: number,
): void {
  const live = new Set<string>();
  for (const mark of marks) {
    live.add(mark.corner);
    let node = brandBugNodes.get(mark.corner);
    if (!node) {
      const root = document.createElement("div");
      root.className = `brand-bug brand-bug--${mark.corner.replace("_", "-")}`;
      const logo = document.createElement("img");
      logo.className = "brand-bug__logo";
      logo.alt = "";
      const caption = document.createElement("span");
      caption.className = "brand-bug__text";
      root.append(logo, caption);
      brandBugLayer.append(root);
      node = { root, logo, caption, signature: "" };
      brandBugNodes.set(mark.corner, node);
    }
    const signature = JSON.stringify(mark);
    if (node.signature !== signature) {
      node.signature = signature;
      // Assigning the same src again would re-decode the image, so only a real
      // change touches it.
      if (mark.imageSrc) {
        if (node.logo.getAttribute("src") !== mark.imageSrc) {
          node.logo.src = mark.imageSrc;
        }
        node.logo.style.display = "";
        node.logo.style.width = `${mark.widthPercent}vw`;
      } else {
        node.logo.removeAttribute("src");
        node.logo.style.display = "none";
      }
      node.caption.textContent = mark.text;
      node.caption.style.display = mark.text ? "" : "none";
      node.caption.style.color = mark.textColor;
      node.caption.style.fontSize = `${mark.textSizePercent}vh`;
      node.root.style.opacity = String(mark.opacityPercent / 100);
      node.root.style.maxWidth = `${Math.max(mark.widthPercent, 12)}vw`;
      node.root.classList.toggle(
        "brand-bug--scrim",
        mark.backgroundStyle === "scrim",
      );
      // vmin keeps the inset visually even on both axes at any aspect ratio.
      node.root.style.setProperty(
        "--brand-bug-margin",
        `${mark.marginPercent}vmin`,
      );
    }
    node.root.style.setProperty("--brand-bug-lift", `${bottomLiftPx}px`);
    node.root.classList.add("visible");
  }
  for (const [corner, node] of brandBugNodes) {
    if (!live.has(corner)) {
      node.root.classList.remove("visible");
    }
  }
}

/**
 * Identity of the alert currently scrolling. The surface re-resolves every
 * second, and rewriting the text or the animation on each tick would restart the
 * scroll from the right edge once a second — the message would never be read.
 */
let activeTickerKey = "";

function showAlertTicker(ticker: TilecastActiveAlertTicker): void {
  document.documentElement.style.setProperty(
    "--plugin-height",
    `${ticker.heightPx}px`,
  );
  contentStage.classList.toggle("plugin-push", ticker.displayMode === "push");
  const key = `${ticker.id}${ticker.message}${ticker.severity}${ticker.pixelsPerSecond}${ticker.heightPx}`;
  if (key !== activeTickerKey) {
    activeTickerKey = key;
    alertTickerSeverity.textContent = ticker.severity;
    alertTickerSeverity.hidden = ticker.severity === "";
    alertTickerText.textContent = ticker.message;
    alertTickerBar.classList.add("visible");
    // The message travels its own width plus the bar's, so it enters from the
    // right edge and leaves past the left one. Duration is derived from that
    // distance rather than fixed, so a long alert scrolls for longer instead of
    // scrolling faster and becoming unreadable.
    const distance =
      alertTickerViewport.clientWidth + alertTickerText.scrollWidth;
    const seconds = Math.max(6, distance / ticker.pixelsPerSecond);
    alertTickerTrack.style.setProperty("--ticker-distance", `${distance}px`);
    // Restarting the animation requires it to be taken off the element first;
    // setting the same name again would otherwise be a no-op.
    alertTickerTrack.style.animation = "none";
    void alertTickerTrack.offsetWidth;
    alertTickerTrack.style.animation = `ticker-scroll ${seconds}s linear infinite`;
    return;
  }
  alertTickerBar.classList.add("visible");
}

/**
 * Noise Meter surface.
 *
 * The bar is drawn from the resolved instance, and only the marker moves on the
 * meter's own ~16Hz loop: rewriting the labels or the zone widths at that rate
 * would be layout work sixteen times a second for a bar that has not changed.
 * Nothing here reaches presentation state — the meter appears, moves, and
 * disappears while the same media element stays mounted.
 */
let noiseMeterSignature = "";

function showNoiseMeter(settings: TilecastNoiseMeterSettings): void {
  document.documentElement.style.setProperty(
    "--plugin-height",
    `${settings.heightPx}px`,
  );
  contentStage.classList.toggle("plugin-push", settings.displayMode === "push");
  const signature = `${settings.id}:${settings.message}:${settings.warningLevel}:${settings.loudLevel}:${settings.heightPx}`;
  if (signature !== noiseMeterSignature) {
    noiseMeterSignature = signature;
    noiseMeterWarning.textContent = settings.message || "TOO LOUD";
    // The three zones are fixed and read left to right: normal, getting loud,
    // too loud. They are published as percentages so the scale is the same
    // geometry the thresholds are expressed in.
    noiseMeterBar.style.setProperty(
      "--noise-warning",
      `${settings.warningLevel}%`,
    );
    noiseMeterBar.style.setProperty("--noise-loud", `${settings.loudLevel}%`);
  }
  updateNoiseMeterMarker();
  if (!noiseMeterBar.classList.contains("visible")) {
    noiseMeterBar.classList.add("visible");
    // A brief emphasis on the warning label when the bar arrives, and nothing
    // after that: a bar that keeps flashing stops being read.
    noiseMeterBar.classList.add("noise-meter--entering");
    window.setTimeout(
      () => noiseMeterBar.classList.remove("noise-meter--entering"),
      1_400,
    );
  }
}

function updateNoiseMeterMarker(): void {
  noiseMeterMarker.style.left = `${noiseMeterReading.level}%`;
}

/**
 * Apply whatever the manifest now says about this screen's meter. Called on
 * every plugin payload, so it has to be safe to call with the same instance
 * repeatedly: an unchanged instance must not reopen the microphone, and a
 * removed one must release it.
 */
function syncNoiseMeter(): void {
  const settings = tilecastNoiseMeter.resolve(activePlugins);
  if (settings === null && noiseMeterSettings === null && !noiseMeterCapture) {
    // The overwhelmingly common case on a screen with no meter configured.
    return;
  }
  const same =
    settings !== null &&
    noiseMeterSettings !== null &&
    JSON.stringify(settings) === JSON.stringify(noiseMeterSettings);
  if (same) return;
  noiseMeterSettings = settings;
  // Thresholds changed: the hysteresis and the open aggregate restart, because
  // a bucket measured against two different thresholds is not one measurement.
  noiseMeterMachine = settings
    ? tilecastNoiseMeter.createStateMachine(settings)
    : null;
  if (settings === null) {
    noiseMeterSignature = "";
  }
  applyNoiseMeterLifecycle();
}

/**
 * Whether the bar's configured display window is open. Re-evaluated rather
 * than cached: the window closes while the player is running, and the corrected
 * clock is what decides.
 */
function noiseMeterWindowOpen(now = new Date()): boolean {
  const settings = noiseMeterSettings;
  if (!settings) return false;
  return tilecastNoiseMeter.scheduleOpen(
    settings,
    new Date(now.getTime() + pluginClockOffsetMs),
  );
}

/** History is kept only while it is wanted and the screen is awake enough. */
function noiseHistoryWanted(): boolean {
  const settings = noiseMeterSettings;
  if (!settings || !settings.historyEnabled) return false;
  return playerAwake || !settings.historyActiveHoursOnly;
}

/**
 * Start or stop the microphone to match what is actually wanted right now.
 *
 * Outside active hours the screen is black, so the live bar has nothing to
 * appear over. If history is also confined to active hours, nothing wants the
 * microphone at all — and then the player genuinely stops listening: the tracks
 * are stopped and the AudioContext is closed, rather than the readings being
 * taken and quietly thrown away.
 */
function applyNoiseMeterLifecycle(): void {
  const settings = noiseMeterSettings;
  const wantsHistory = noiseHistoryWanted();
  // The bar is a surface over content. A sleeping screen has no content for it,
  // and neither does a closed display window. When history does not want the
  // microphone either, the player stops listening rather than measuring for a
  // bar that cannot appear.
  const wantsLive = settings !== null && playerAwake && noiseMeterWindowOpen();
  if (!settings || (!wantsHistory && !wantsLive)) {
    flushNoiseHistory();
    noiseHistory = null;
    noiseMeterCapture?.stop();
    noiseMeterCapture = null;
    noiseMeterSmoother.reset();
    noiseMeterReading = { state: "unavailable", visible: false, level: 0 };
    reportNoiseMeterState("inactive", null);
    updatePluginSurface();
    return;
  }
  if (wantsHistory) {
    noiseHistory ??= tilecastNoiseMeter.createHistoryAggregator(settings);
  } else if (noiseHistory) {
    flushNoiseHistory();
    noiseHistory = null;
  }
  if (!noiseMeterCapture) {
    noiseMeterCapture = tilecastNoiseMeter.createCapture({
      onLevel: onNoiseSample,
      // A microphone problem is a player diagnostic, not a playback error: it
      // must be findable in the logs without being reported as a failure of the
      // content that is still playing perfectly well.
      onDiagnostic: (message, detail) =>
        tilecast.reportNoiseMeterDiagnostic(message, detail),
    });
    noiseMeterCapture.start();
  }
  updatePluginSurface();
}

/** Hand the part-finished bucket over rather than losing what it measured. */
function flushNoiseHistory(): void {
  const bucket = noiseHistory?.flush() ?? null;
  if (bucket) {
    tilecast.reportNoiseMeter({ status: currentNoiseStatus(), bucket });
  }
}

function currentNoiseStatus(): string {
  if (!noiseMeterCapture) return "inactive";
  switch (noiseMeterReading.state) {
    case "unavailable":
      return "unavailable";
    case "loud":
    case "recovering":
      return "loud";
    default:
      return "normal";
  }
}

/**
 * Report state to the trusted side. Called on a state change and once per
 * completed bucket — never at the sampling rate. The microphone's rate has no
 * relationship to how often anything leaves this renderer.
 */
function reportNoiseMeterState(
  status: string,
  level: number | null,
  bucket: TilecastNoiseHistoryBucket | null = null,
): void {
  if (status === lastReportedNoiseStatus && bucket === null) return;
  lastReportedNoiseStatus = status;
  tilecast.reportNoiseMeter({ status, level, bucket });
}

function onNoiseSample(rms: number | null): void {
  const settings = noiseMeterSettings;
  const machine = noiseMeterMachine;
  if (!settings || !machine) return;
  const at = performance.now();
  const level =
    rms === null
      ? null
      : noiseMeterSmoother.push(
          tilecastNoiseMeter.levelFromRms(rms, settings.sensitivity),
          at,
        );
  if (rms === null) noiseMeterSmoother.reset();
  const previous = noiseMeterReading;
  noiseMeterReading = machine.update(level, at);
  // A trigger is counted where it happens: the moment the state machine enters
  // its loud state. Counting red buckets afterwards would report one long
  // disturbance as dozens of events.
  const enteredLoud =
    noiseMeterReading.state === "loud" && previous.state !== "loud";
  if (noiseHistory) {
    // Buckets are on the fixed wall-clock grid, corrected by the same server
    // offset the rest of the plugin surface uses, so two players and a restart
    // all produce the same slots.
    const bucket = noiseHistory.push(
      level,
      Date.now() + pluginClockOffsetMs,
      enteredLoud,
    );
    if (bucket) {
      reportNoiseMeterState(
        currentNoiseStatus(),
        noiseMeterReading.level,
        bucket,
      );
    }
  }
  reportNoiseMeterState(currentNoiseStatus(), noiseMeterReading.level);
  if (noiseMeterReading.visible !== previous.visible) {
    // Handing the strip over is worth doing now rather than on the next
    // one-second plugin tick; nothing else about the surface has changed.
    updatePluginSurface();
    return;
  }
  if (
    noiseMeterReading.visible &&
    noiseMeterBar.classList.contains("visible")
  ) {
    updateNoiseMeterMarker();
  }
}

// ------------------------------------------------- render-tree interpreter
//
// Timers created by self-updating nodes (clock, countdown) are tracked so a
// layer swap tears them down — otherwise stale tickers would leak and keep an
// old CPU warm.
let nodeTimers: number[] = [];

function clearNodeTimers(): void {
  for (const id of nodeTimers) {
    window.clearInterval(id);
  }
  nodeTimers = [];
}

function px(value: unknown, fallback = ""): string {
  return typeof value === "number" ? `${value}px` : fallback;
}

function applyBoxStyle(el: HTMLElement, style: Record<string, unknown>): void {
  const s = el.style;
  if (style["background"]) s.background = String(style["background"]);
  if (style["color"]) s.color = String(style["color"]);
  if (typeof style["padding"] === "number") s.padding = px(style["padding"]);
  if (typeof style["gap"] === "number") s.gap = px(style["gap"]);
  if (typeof style["radius"] === "number") s.borderRadius = px(style["radius"]);
  if (typeof style["opacity"] === "number")
    s.opacity = String(style["opacity"]);
  if (typeof style["borderWidth"] === "number" && style["borderWidth"]) {
    s.border = `${px(style["borderWidth"])} solid ${String(style["borderColor"] ?? "#000")}`;
  }
  if (style["columns"]) {
    s.display = "grid";
    s.gridTemplateColumns = String(style["columns"]);
  } else {
    s.display = "flex";
    s.flexDirection = style["direction"] === "row" ? "row" : "column";
  }
  const justifyMap: Record<string, string> = {
    start: "flex-start",
    center: "center",
    end: "flex-end",
    "space-between": "space-between",
    "space-around": "space-around",
  };
  const alignMap: Record<string, string> = {
    start: "flex-start",
    center: "center",
    end: "flex-end",
    stretch: "stretch",
  };
  if (style["justify"])
    s.justifyContent = justifyMap[String(style["justify"])] ?? "flex-start";
  if (style["align"])
    s.alignItems = alignMap[String(style["align"])] ?? "stretch";
  if (typeof style["grow"] === "number") s.flexGrow = String(style["grow"]);
  if (typeof style["width"] === "number")
    s.width = style["width"] <= 100 ? `${style["width"]}%` : px(style["width"]);
  if (typeof style["height"] === "number")
    s.height =
      style["height"] <= 100 ? `${style["height"]}%` : px(style["height"]);
  if (style["wrap"]) s.flexWrap = "wrap";
}

function applyTextStyle(el: HTMLElement, style: Record<string, unknown>): void {
  const s = el.style;
  if (style["color"]) s.color = String(style["color"]);
  if (style["background"]) s.background = String(style["background"]);
  if (typeof style["fontSize"] === "number") s.fontSize = px(style["fontSize"]);
  if (typeof style["fontWeight"] === "number")
    s.fontWeight = String(style["fontWeight"]);
  if (style["fontFamily"])
    s.fontFamily = `${String(style["fontFamily"])}, system-ui, sans-serif`;
  if (style["align"]) s.textAlign = String(style["align"]);
  if (typeof style["lineHeight"] === "number")
    s.lineHeight = String(style["lineHeight"]);
  if (typeof style["letterSpacing"] === "number")
    s.letterSpacing = px(style["letterSpacing"]);
  if (typeof style["padding"] === "number") s.padding = px(style["padding"]);
  if (typeof style["grow"] === "number") s.flexGrow = String(style["grow"]);
  if (typeof style["maxLines"] === "number" && style["maxLines"]) {
    s.display = "-webkit-box";
    s.webkitBoxOrient = "vertical";
    (s as unknown as Record<string, string>)["WebkitLineClamp"] = String(
      style["maxLines"],
    );
    s.overflow = "hidden";
  }
  const va = style["verticalAlign"];
  if (va === "top") s.alignSelf = "flex-start";
  else if (va === "bottom") s.alignSelf = "flex-end";
  if (style["autoFit"]) {
    el.dataset["autofitMin"] = String(
      typeof style["minFontSize"] === "number" ? style["minFontSize"] : 8,
    );
    el.dataset["autofitBase"] = String(
      typeof style["fontSize"] === "number" ? style["fontSize"] : 16,
    );
    s.maxWidth = "100%";
  }
}

/**
 * Shrink one auto-fit text node until it sits inside its parent box, starting
 * over from the authored size so a value that got shorter can grow back. The
 * author's scale sets that starting size; this is the fit-to-bounds guard that
 * keeps an enlarged or unusually long value from spilling past the margins.
 */
function fitTextElement(el: HTMLElement): void {
  const parent = el.parentElement;
  const base = Number(el.dataset["autofitBase"]);
  if (!parent || !Number.isFinite(base)) return;
  const minimum = Number(el.dataset["autofitMin"]) || 8;
  let size = base;
  el.style.fontSize = `${size}px`;
  let guard = 0;
  while (
    guard++ < 80 &&
    size > minimum &&
    (el.scrollWidth > parent.clientWidth + 1 ||
      el.scrollHeight > parent.clientHeight + 1)
  ) {
    size = Math.max(minimum, size * 0.92);
    el.style.fontSize = `${size}px`;
  }
}

/** Fit every auto-fit node in a mounted subtree. Needs real measurements. */
function applyAutoFit(container: HTMLElement): void {
  container
    .querySelectorAll<HTMLElement>("[data-autofit-base]")
    .forEach(fitTextElement);
}

function formatClock(node: AnyNode): string {
  const now = new Date();
  const locale = String(node["locale"] ?? "en-US");
  const options: Intl.DateTimeFormatOptions = {
    timeZone: String(node["timezone"] ?? "UTC"),
    hour: "numeric",
    minute: "2-digit",
    second: node["showSeconds"] ? "2-digit" : undefined,
  };
  if (typeof node["hour12"] === "boolean") {
    options.hour12 = node["hour12"];
  } else if (!node["locale"]) {
    // Preserve the original en-US 12-hour output for clock nodes compiled by
    // older Servers, which do not carry an organization profile.
    options.hour12 = true;
  }
  try {
    return new Intl.DateTimeFormat(locale, options).format(now);
  } catch {
    return new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: "UTC",
    }).format(now);
  }
}

function formatCountdown(node: AnyNode): string {
  const now = Date.now();
  const recurrence = String(node["recurrence"] ?? "none");
  const target = resolveCountdownTarget(
    String(node["target"] ?? ""),
    String(node["timezone"] ?? "UTC"),
    recurrence,
    now,
  );
  let remaining = target - now;
  if (node["compact"] === true) {
    const body = tilecastCountdownDisplay.compact(remaining);
    return `${String(node["prefix"] ?? "")}${body}${String(node["suffix"] ?? "")}`;
  }
  const countUp = node["countUp"] === true;
  if (remaining <= 0 && !countUp && recurrence === "none") {
    const action = String(node["completionAction"] ?? "completed_text");
    if (action === "hide") return "";
    if (action === "count_up") remaining = now - target;
    else return String(node["completionText"] ?? "");
  } else if (remaining <= 0) {
    remaining = now - target;
  }
  const abs = Math.abs(remaining);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1_000);
  const parts: string[] = [];
  if (node["showDays"] !== false && days > 0) parts.push(`${days}d`);
  if (node["showHours"] !== false)
    parts.push(`${String(hours).padStart(2, "0")}h`);
  if (node["showMinutes"] !== false)
    parts.push(`${String(minutes).padStart(2, "0")}m`);
  if (node["showSeconds"] === true)
    parts.push(`${String(seconds).padStart(2, "0")}s`);
  return parts.join(" ");
}

function resolveCountdownTarget(
  target: string,
  timezone: string,
  recurrence: string,
  now: number,
): number {
  const zone = validCountdownTimezone(timezone);
  const original = parseCountdownTarget(target, zone);
  if (original === null || recurrence === "none") return original ?? now;

  const seed = countdownDateParts(original, zone);
  const current = countdownDateParts(now, zone);
  let date = countdownRecurringDate(seed, current, recurrence);
  let candidate = countdownZonedEpoch(
    { ...date, ...countdownTime(seed) },
    zone,
  );
  if (candidate <= now) {
    date = advanceCountdownDate(date, seed, recurrence);
    candidate = countdownZonedEpoch({ ...date, ...countdownTime(seed) }, zone);
  }
  return candidate;
}

interface CountdownDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

type CountdownDate = Pick<CountdownDateParts, "year" | "month" | "day">;

function validCountdownTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return "UTC";
  }
}

function parseCountdownTarget(target: string, timezone: string): number | null {
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(target)) {
    const parsed = Date.parse(target);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(
      target,
    );
  if (!match) return null;
  return countdownZonedEpoch(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6] ?? 0),
    },
    timezone,
  );
}

function countdownDateParts(
  epochMs: number,
  timezone: string,
): CountdownDateParts {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values["year"]!,
    month: values["month"]!,
    day: values["day"]!,
    hour: values["hour"]!,
    minute: values["minute"]!,
    second: values["second"]!,
  };
}

function countdownZonedEpoch(
  parts: CountdownDateParts,
  timezone: string,
): number {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = countdownDateParts(candidate, timezone);
    const rendered = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const adjustment = desired - rendered;
    if (adjustment === 0) break;
    candidate += adjustment;
  }
  return candidate;
}

function countdownRecurringDate(
  seed: CountdownDateParts,
  current: CountdownDateParts,
  recurrence: string,
): CountdownDate {
  if (recurrence === "daily")
    return countdownDate(current.year, current.month, current.day);
  if (recurrence === "weekly") {
    const currentDay = countdownUTCDate(current).getUTCDay();
    const seedDay = countdownUTCDate(seed).getUTCDay();
    return addCountdownDays(
      countdownDate(current.year, current.month, current.day),
      (seedDay - currentDay + 7) % 7,
    );
  }
  if (recurrence === "monthly") {
    return countdownDate(
      current.year,
      current.month,
      Math.min(seed.day, countdownDaysInMonth(current.year, current.month)),
    );
  }
  return countdownDate(
    current.year,
    seed.month,
    Math.min(seed.day, countdownDaysInMonth(current.year, seed.month)),
  );
}

function advanceCountdownDate(
  date: CountdownDate,
  seed: CountdownDateParts,
  recurrence: string,
): CountdownDate {
  if (recurrence === "daily") return addCountdownDays(date, 1);
  if (recurrence === "weekly") return addCountdownDays(date, 7);
  if (recurrence === "monthly") {
    const next = new Date(Date.UTC(date.year, date.month, 1));
    return countdownDate(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      Math.min(
        seed.day,
        countdownDaysInMonth(next.getUTCFullYear(), next.getUTCMonth() + 1),
      ),
    );
  }
  return countdownDate(
    date.year + 1,
    seed.month,
    Math.min(seed.day, countdownDaysInMonth(date.year + 1, seed.month)),
  );
}

function countdownDate(
  year: number,
  month: number,
  day: number,
): CountdownDate {
  return { year, month, day };
}

function countdownTime(
  parts: CountdownDateParts,
): Pick<CountdownDateParts, "hour" | "minute" | "second"> {
  return { hour: parts.hour, minute: parts.minute, second: parts.second };
}

function addCountdownDays(parts: CountdownDate, days: number): CountdownDate {
  const value = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return countdownDate(
    value.getUTCFullYear(),
    value.getUTCMonth() + 1,
    value.getUTCDate(),
  );
}

function countdownUTCDate(parts: CountdownDate): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function countdownDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildRenderNode(node: AnyNode): HTMLElement {
  switch (node["t"]) {
    case "box": {
      const el = document.createElement("div");
      applyBoxStyle(el, (node["style"] as Record<string, unknown>) ?? {});
      for (const child of (node["children"] as AnyNode[]) ?? []) {
        el.appendChild(buildRenderNode(child));
      }
      return el;
    }
    case "text": {
      const el = document.createElement("div");
      el.textContent = String(node["value"] ?? "");
      applyTextStyle(el, (node["style"] as Record<string, unknown>) ?? {});
      return el;
    }
    case "image": {
      const el = document.createElement("img");
      el.style.objectFit = FIT_MODES[String(node["fit"])] ?? "contain";
      el.style.width = "100%";
      el.style.height = "100%";
      if (typeof node["radius"] === "number")
        el.style.borderRadius = px(node["radius"]);
      el.src = String(node["src"] ?? "");
      return el;
    }
    case "qr": {
      const wrap = document.createElement("div");
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.alignItems = "center";
      wrap.style.gap = "8px";
      const img = document.createElement("img");
      img.style.width = "min(70vh, 70vw)";
      img.style.height = "auto";
      img.src = String(node["src"] ?? "");
      wrap.appendChild(img);
      if (node["label"]) {
        const label = document.createElement("div");
        label.textContent = String(node["label"]);
        label.style.fontSize = "28px";
        wrap.appendChild(label);
      }
      return wrap;
    }
    case "shape": {
      const el = document.createElement("div");
      const style = (node["style"] as Record<string, unknown>) ?? {};
      el.style.width = "100%";
      el.style.height = "100%";
      if (node["shape"] === "circle") el.style.borderRadius = "50%";
      else if (typeof style["radius"] === "number")
        el.style.borderRadius = px(style["radius"]);
      if (style["fill"]) el.style.background = String(style["fill"]);
      if (style["strokeWidth"] && Number(style["strokeWidth"]) > 0) {
        el.style.border = `${px(style["strokeWidth"])} solid ${String(style["stroke"] ?? "#fff")}`;
      }
      if (node["shape"] === "line") {
        el.style.height = px(style["strokeWidth"] ?? 1);
        el.style.background = String(style["stroke"] ?? "#fff");
        el.style.border = "none";
      }
      return el;
    }
    case "progress": {
      const track = document.createElement("div");
      track.style.width = "80%";
      track.style.height = "20px";
      track.style.borderRadius = "10px";
      track.style.background = String(node["track"] ?? "#333");
      track.style.overflow = "hidden";
      const bar = document.createElement("div");
      bar.style.height = "100%";
      bar.style.width = `${Math.round(Number(node["ratio"] ?? 0) * 100)}%`;
      bar.style.background = String(node["color"] ?? "#4C8BF5");
      track.appendChild(bar);
      return track;
    }
    case "divider": {
      const el = document.createElement("div");
      if (node["vertical"]) {
        el.style.width = "1px";
        el.style.alignSelf = "stretch";
      } else {
        el.style.height = "1px";
        el.style.width = "100%";
      }
      el.style.background = String(node["color"] ?? "#2A3644");
      return el;
    }
    case "spacer": {
      const el = document.createElement("div");
      el.style.flexGrow = String(node["grow"] ?? 1);
      return el;
    }
    case "marquee":
      return buildMarquee(node);
    case "chart":
      return buildChart(node);
    case "clock": {
      const el = document.createElement("div");
      applyTextStyle(el, (node["style"] as Record<string, unknown>) ?? {});
      const tick = () => {
        el.textContent = formatClock(node);
        if (el.isConnected) fitTextElement(el);
      };
      tick();
      nodeTimers.push(
        window.setInterval(tick, node["showSeconds"] ? 1_000 : 15_000),
      );
      return el;
    }
    case "countdown": {
      const el = document.createElement("div");
      applyTextStyle(el, (node["style"] as Record<string, unknown>) ?? {});
      const tick = () => {
        el.textContent = formatCountdown(node);
        if (el.isConnected) fitTextElement(el);
      };
      tick();
      nodeTimers.push(
        window.setInterval(tick, node["showSeconds"] ? 1_000 : 30_000),
      );
      return el;
    }
    default: {
      const el = document.createElement("div");
      for (const child of (node["children"] as AnyNode[]) ?? []) {
        el.appendChild(buildRenderNode(child));
      }
      return el;
    }
  }
}

function buildMarquee(node: AnyNode): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.overflow = "hidden";
  wrap.style.whiteSpace = "nowrap";
  wrap.style.width = "100%";
  const track = document.createElement("div");
  track.textContent = String(node["text"] ?? "");
  applyTextStyle(track, (node["style"] as Record<string, unknown>) ?? {});
  track.style.display = "inline-block";
  track.style.paddingLeft = "100%";
  track.style.willChange = "transform";
  const dur = Math.max(Number(node["durationMs"] ?? 18_000), 4_000);
  const dir =
    node["direction"] === "right" ? "tc-marquee-right" : "tc-marquee-left";
  track.style.animation = `${dir} ${dur}ms linear infinite`;
  wrap.appendChild(track);
  return wrap;
}

function buildChart(node: AnyNode): HTMLElement {
  // Lightweight inline SVG — no chart library, no animation (kind to old GPU).
  const series = (node["series"] as number[]) ?? [];
  const colors = (node["colors"] as string[]) ?? ["#4C8BF5"];
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 100 60");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.width = "100%";
  svg.style.height = "100%";
  const max = Math.max(1, ...series.map((v) => Math.abs(v)));
  if (node["chart"] === "donut") {
    const total = series.reduce((a, b) => a + Math.abs(b), 0) || 1;
    let angle = -Math.PI / 2;
    series.forEach((v, i) => {
      const slice = (Math.abs(v) / total) * Math.PI * 2;
      const path = document.createElementNS(svgNS, "path");
      const [cx, cy, r] = [50, 30, 25];
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(angle + slice);
      const y2 = cy + r * Math.sin(angle + slice);
      const large = slice > Math.PI ? 1 : 0;
      path.setAttribute(
        "d",
        `M${cx} ${cy} L${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`,
      );
      path.setAttribute("fill", colors[i % colors.length]!);
      svg.appendChild(path);
      angle += slice;
    });
  } else if (node["chart"] === "bar") {
    const w = 100 / Math.max(series.length, 1);
    series.forEach((v, i) => {
      const rect = document.createElementNS(svgNS, "rect");
      const h = (Math.abs(v) / max) * 58;
      rect.setAttribute("x", String(i * w + w * 0.15));
      rect.setAttribute("y", String(60 - h));
      rect.setAttribute("width", String(w * 0.7));
      rect.setAttribute("height", String(h));
      rect.setAttribute("fill", colors[i % colors.length]!);
      svg.appendChild(rect);
    });
  } else {
    const step = 100 / Math.max(series.length - 1, 1);
    const points = series
      .map((v, i) => `${i * step},${60 - (Math.abs(v) / max) * 58}`)
      .join(" ");
    const poly = document.createElementNS(svgNS, "polyline");
    poly.setAttribute("points", points);
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke", colors[0]!);
    poly.setAttribute("stroke-width", "2");
    svg.appendChild(poly);
  }
  return svg as unknown as HTMLElement;
}

// ---------------------------------------------------------------- playback

function startPlaying(presentation: RendererPresentation): void {
  hideMessage();
  items = presentation.items ?? [];
  generation = presentation.generation ?? 0;
  playbackAuthority = playbackAuthorityOf(presentation.synchronized);
  index = 0;
  consecutiveFailures = 0;
  consecutiveEmptySkips = 0;
  clearTimers();
  if (items.length === 0) {
    return;
  }
  void renderItem(items[0]!, generation);
}

function advance(): void {
  if (items.length === 0) {
    return;
  }
  const captured = playbackToken();
  tilecast.reportProgress(currentItem?.id ?? null, "item-transition");
  if (advanceTimer !== null) {
    window.clearTimeout(advanceTimer);
  }
  // The main process may activate a pending manifest on that boundary and
  // push a fresh presentation; give that message one macrotask to land so
  // the swap is seamless rather than one item late.
  advanceTimer = window.setTimeout(() => {
    advanceTimer = null;
    if (!stillCurrent(captured)) {
      return; // a new presentation or a newer item took over
    }
    index = (index + 1) % items.length;
    void renderItem(items[index]!, captured.generation);
  }, 0);
}

function failItem(item: RendererItem, message: string): void {
  tilecast.reportPlaybackError(item.id, message);
  consecutiveFailures += 1;
  if (playbackAuthority === "shared") {
    // The group timeline moves this screen to the next occurrence. Advancing
    // locally would desync the group until the next shared boundary.
    return;
  }
  const captured = playbackToken();
  // Isolate the failure and keep rotating; pause grows when everything is
  // failing so a fully broken playlist does not spin at 100% CPU.
  const delay = Math.min(
    2_000 * Math.max(consecutiveFailures - items.length, 0) + 1_000,
    30_000,
  );
  if (failTimer !== null) {
    window.clearTimeout(failTimer);
  }
  failTimer = window.setTimeout(() => {
    failTimer = null;
    // The item that failed may long since have been replaced — by a retry
    // command, a new presentation, or the next item.
    if (!stillCurrent(captured)) {
      return;
    }
    index = (index + 1) % items.length;
    void renderItem(items[index]!, captured.generation);
  }, delay);
}

/**
 * Advance at a fixed item duration. Under a shared timeline the boundary is the
 * timeline's to schedule, so no local timer is created at all.
 */
function scheduleItemCompletion(item: RendererItem, delayMs: number): void {
  if (playbackAuthority === "shared") {
    return;
  }
  const arbiter = completion;
  const captured = playbackToken();
  itemTimer = window.setTimeout(() => {
    itemTimer = null;
    if (!stillCurrent(captured) || currentItem !== item) {
      return;
    }
    if (arbiter.complete("duration-timer") === "ignore") {
      return;
    }
    advance();
  }, delayMs);
}

async function renderItem(
  item: RendererItem,
  myGeneration: number,
): Promise<void> {
  if (myGeneration !== generation) {
    return;
  }
  clearTimers();
  renderToken += 1;
  // Decided before `currentItem` moves on: the item leaving the screen is what
  // says whether this swap has anything to dissolve.
  activeTransition = transitionForSwap(
    item.transition,
    currentItem?.id ?? null,
    item.id,
  );
  currentItem = item;
  // Exactly one completion may act per occurrence. Only a single-video local
  // playlist restarts in place; everything else advances.
  completion = new ItemCompletion(
    playbackAuthority,
    items.length === 1 && item.kind === "video",
  );
  // The main process opens a child playback session on this signal; without it
  // an item could only ever be reported as having finished.
  tilecast.reportProgress(item.id, "item-started");
  if (!(
    item.kind === "widget" &&
    item.widget?.autoSkip &&
    playbackAuthority === "local"
  )) {
    consecutiveEmptySkips = 0;
  }
  const fit = FIT_MODES[item.fitMode] ?? "contain";

  if (item.kind === "image") {
    renderImage(item, fit, myGeneration);
  } else if (item.kind === "video") {
    renderVideo(item, fit, myGeneration);
  } else if (item.kind === "widget") {
    renderWidgetItem(item, myGeneration);
  } else if (item.kind === "layout") {
    renderLayoutItem(item, myGeneration);
  } else {
    // website and youtube both render in a <webview>.
    renderWebsite(item, myGeneration);
  }
}

function renderWidgetItem(item: RendererItem, myGeneration: number): void {
  const payload = item.widget;
  if (!payload) {
    failItem(item, "widget payload missing");
    return;
  }
  clearNodeTimers();
  if (payload.autoSkip && playbackAuthority === "local") {
    consecutiveEmptySkips += 1;
    tilecast.reportProgress(item.id, "widget-empty");
    const exhausted = consecutiveEmptySkips >= items.length;
    const delayMs = exhausted ? 30_000 : 0;
    const captured = playbackToken();
    advanceTimer = window.setTimeout(() => {
      advanceTimer = null;
      if (stillCurrent(captured)) {
        if (exhausted) consecutiveEmptySkips = 0;
        advance();
      }
    }, delayMs);
    return;
  }
  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = "100%";
  container.style.background = payload.background || "#000";
  container.appendChild(buildRenderNode(payload.root));
  fillBackLayer(container);
  swapLayers();
  // Only measurable once the layers have swapped and the container has a size.
  applyAutoFit(container);
  consecutiveFailures = 0;
  tilecast.reportProgress(item.id, "widget-shown");
  // A widget is healthy content; keep the progress heartbeat alive and, for
  // fixed-duration widget items, advance at the boundary.
  stillImageTicker = window.setInterval(() => {
    if (myGeneration === generation) {
      tilecast.reportProgress(item.id, "widget-alive");
    }
  }, 30_000);
  if (item.durationMs) {
    scheduleItemCompletion(item, item.durationMs);
  }
}

function renderLayoutItem(item: RendererItem, myGeneration: number): void {
  const payload = item.layout;
  if (!payload) {
    failItem(item, "layout payload missing");
    return;
  }
  clearNodeTimers();
  const canvas = document.createElement("div");
  canvas.style.position = "relative";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.background = payload.background || "#000";
  canvas.style.overflow = "hidden";
  if (payload.backgroundImage) {
    const bg = document.createElement("img");
    bg.src = payload.backgroundImage;
    bg.style.position = "absolute";
    const crop = payload.backgroundImageViewport;
    if (crop) {
      bg.style.left = `${(-crop.x / crop.width) * 100}%`;
      bg.style.top = `${(-crop.y / crop.height) * 100}%`;
      bg.style.width = `${(crop.canvasWidth / crop.width) * 100}%`;
      bg.style.height = `${(crop.canvasHeight / crop.height) * 100}%`;
    } else {
      bg.style.inset = "0";
      bg.style.width = "100%";
      bg.style.height = "100%";
    }
    bg.style.objectFit = "cover";
    canvas.appendChild(bg);
  }
  const w = payload.canvasWidth || 1920;
  const h = payload.canvasHeight || 1080;
  for (const zone of payload.zones) {
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.left = `${(zone.x / w) * 100}%`;
    el.style.top = `${(zone.y / h) * 100}%`;
    el.style.width = `${(zone.width / w) * 100}%`;
    el.style.height = `${(zone.height / h) * 100}%`;
    el.style.opacity = String(zone.opacity ?? 1);
    el.style.overflow = "hidden";
    if (zone.radius) el.style.borderRadius = `${zone.radius}px`;
    // Each zone reports its own render evidence, so a layout whose zones have
    // silently died is distinguishable from one that is working. Reporting
    // only for the layout as a whole would hide exactly that.
    if (zone.render) {
      const node = buildRenderNode(zone.render);
      el.appendChild(node);
      // A render node is only evidence once its first frame has painted.
      requestAnimationFrame(() => {
        if (myGeneration === generation && node.isConnected) {
          tilecast.reportProgress(item.id, "layout-zone-rendered", zone.id);
        }
      });
    } else if (zone.image) {
      const img = document.createElement("img");
      img.src = zone.image.src;
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = FIT_MODES[zone.image.fit] ?? "contain";
      // On load, not on append: an image element that never decodes is not
      // evidence that anything appeared in the zone.
      img.onload = () => {
        if (myGeneration === generation) {
          tilecast.reportProgress(item.id, "layout-zone-rendered", zone.id);
        }
      };
      el.appendChild(img);
    } else if (zone.playlistItems && zone.playlistItems.length > 0) {
      startZonePlaylist(
        el,
        zone.playlistItems,
        () => generation === myGeneration,
        // A rotating zone reports every time it advances, so it can be held
        // to a continuing expectation rather than only an initial one.
        () => tilecast.reportProgress(item.id, "layout-zone-rendered", zone.id),
      );
    } else {
      // An empty zone owes nothing; reporting for it keeps the pending set
      // honest rather than leaving a zone permanently outstanding.
      tilecast.reportProgress(item.id, "layout-zone-rendered", zone.id);
    }
    canvas.appendChild(el);
  }
  fillBackLayer(canvas);
  swapLayers();
  applyAutoFit(canvas);
  consecutiveFailures = 0;
  tilecast.reportProgress(item.id, "layout-shown");
  stillImageTicker = window.setInterval(() => {
    if (myGeneration === generation) {
      tilecast.reportProgress(item.id, "layout-alive");
    }
  }, 30_000);
  if (item.durationMs) {
    scheduleItemCompletion(item, item.durationMs);
  }
}

/** Independently-rotating media loop inside a layout playlist zone. */
function startZonePlaylist(
  container: HTMLElement,
  items: LayoutZonePayload["playlistItems"],
  alive: () => boolean,
  onAdvance?: () => void,
): void {
  const list = items ?? [];
  let zoneIndex = 0;
  let timer: number | null = null;
  let zoneVideo: HTMLVideoElement | null = null;

  // A zone outlives nothing: once its layout is no longer the active item its
  // container is detached, and any timer or media event still pointing at it
  // must stop rather than keep a decoder warm or drive a dead loop.
  const stop = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (zoneVideo) {
      zoneVideo.onended = null;
      zoneVideo.onerror = null;
      zoneVideo.pause();
      zoneVideo = null;
    }
  };
  zoneTeardowns.push(stop);

  let mounted = false;
  const active = () =>
    zoneStepAllowed({
      alive: alive(),
      mounted,
      connected: container.isConnected,
    });
  const showLater = (delayMs: number) => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      timer = null;
      showNext();
    }, delayMs);
  };

  const showNext = () => {
    if (!active() || list.length === 0) {
      stop();
      return;
    }
    const zi = list[zoneIndex % list.length]!;
    zoneIndex += 1;
    // Every advance is fresh evidence that this zone is still alive.
    onAdvance?.();
    if (zi.kind === "video") {
      const video = document.createElement("video");
      video.src = zi.src;
      video.muted = zi.muted;
      video.volume = Math.min(Math.max(zi.volume, 0), 1);
      video.autoplay = true;
      video.loop = zi.loop || list.length === 1;
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.objectFit = FIT_MODES[zi.fit] ?? "contain";
      video.onended = () => {
        // A detached element from a layout that is no longer active must not
        // drive its old zone loop.
        if (!video.loop && video.isConnected && active()) showNext();
      };
      video.onerror = () => showLater(2_000);
      if (zoneVideo) {
        zoneVideo.pause();
      }
      zoneVideo = video;
      container.replaceChildren(video);
      void video.play().catch(() => showLater(2_000));
    } else {
      const img = document.createElement("img");
      img.src = zi.src;
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = FIT_MODES[zi.fit] ?? "contain";
      if (zoneVideo) {
        zoneVideo.pause();
        zoneVideo = null;
      }
      container.replaceChildren(img);
      if (list.length > 1) {
        showLater(zi.durationMs ?? 10_000);
      }
    }
    mounted = true;
  };
  showNext();
}

function renderImage(
  item: RendererItem,
  fit: string,
  myGeneration: number,
): void {
  const img = document.createElement("img");
  const viewport = item.viewport;
  let target: HTMLElement = img;
  if (viewport) {
    const frame = document.createElement("div");
    frame.style.position = "relative";
    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.overflow = "hidden";
    img.style.position = "absolute";
    img.style.left = `${(-viewport.x / viewport.width) * 100}%`;
    img.style.top = `${(-viewport.y / viewport.height) * 100}%`;
    img.style.width = `${(viewport.canvasWidth / viewport.width) * 100}%`;
    img.style.height = `${(viewport.canvasHeight / viewport.height) * 100}%`;
    if (viewport.rotation) {
      img.style.transformOrigin = "top left";
      img.style.transform = `rotate(${viewport.rotation}deg)`;
    }
    frame.appendChild(img);
    target = frame;
  }
  img.style.objectFit = fit;
  img.onload = () => {
    if (myGeneration !== generation || currentItem !== item) {
      return;
    }
    swapLayers();
    consecutiveFailures = 0;
    tilecast.reportProgress(item.id, "image-shown");
    // A long-lived still image is healthy; say so periodically.
    stillImageTicker = window.setInterval(() => {
      tilecast.reportProgress(item.id, "image-shown");
    }, 30_000);
    scheduleItemCompletion(item, item.durationMs ?? 10_000);
  };
  img.onerror = () => {
    if (myGeneration === generation && currentItem === item) {
      failItem(item, "image failed to load");
    }
  };
  fillBackLayer(target);
  img.src = item.src;
}

function renderVideo(
  item: RendererItem,
  fit: string,
  myGeneration: number,
): void {
  const video = document.createElement("video");
  video.style.objectFit = fit;
  video.autoplay = false;
  video.muted = !item.audioEnabled;
  video.volume = Math.min(Math.max(item.volume, 0), 1);
  video.playsInline = true;
  // A group timeline may update while the previous layer is fading out. The
  // correction code uses these to find the newest mounted element and avoid
  // seeking the outgoing one — the mount counter is what distinguishes two
  // occurrences of the same item, which share an id.
  video.dataset.tilecastItemId = item.id;
  video.dataset.tilecastMount = String(renderToken);

  const startS = (item.videoStartOffsetMs ?? 0) / 1_000;
  const endS =
    item.videoEndOffsetMs !== null ? item.videoEndOffsetMs / 1_000 : null;
  let lastReportedAt = 0;
  // Captured, so a stale event on this element can never consult (or settle)
  // the arbiter belonging to a later item.
  const arbiter = completion;

  const finish = (source: CompletionSource) => {
    if (
      myGeneration !== generation ||
      currentItem !== item ||
      !video.isConnected
    ) {
      return;
    }
    const outcome = arbiter.complete(source);
    if (outcome === "ignore") {
      return;
    }
    // One completion path won the occurrence; cancel the competing timer so it
    // cannot fire into the restart that is about to happen.
    if (itemTimer !== null) {
      window.clearTimeout(itemTimer);
      itemTimer = null;
    }
    if (outcome === "restart") {
      // Single-item loop: seamless restart without tearing down the element.
      // The guard stays closed until playback has genuinely resumed below.
      tilecast.reportProgress(item.id, "item-transition");
      video.currentTime = startS;
      void video.play().catch(() => failItem(item, "video restart failed"));
      return;
    }
    advance();
  };

  video.oncanplay = () => {
    if (myGeneration !== generation || currentItem !== item) {
      return;
    }
    if (!video.dataset.shown) {
      video.dataset.shown = "1";
      // Swapping on the first playable frame is what keeps the outgoing layer
      // alive exactly until the incoming video has something to show.
      swapLayers();
      consecutiveFailures = 0;
      void video.play().catch(() => failItem(item, "video autoplay failed"));
    }
  };
  video.ontimeupdate = () => {
    if (myGeneration !== generation || currentItem !== item) {
      return;
    }
    const now = Date.now();
    if (now - lastReportedAt >= 10_000) {
      lastReportedAt = now;
      tilecast.reportProgress(item.id, "video-progress");
    }
    // Evidence that a restarted occurrence is actually running again. Reopening
    // the completion guard any earlier would let the losing signal through and
    // restart the video a second time.
    if (
      arbiter.settledForOccurrence &&
      video.currentTime >= startS + 0.15 &&
      (endS === null || video.currentTime < endS)
    ) {
      arbiter.occurrenceStarted();
    }
    if (endS !== null && video.currentTime >= endS) {
      finish("end-offset");
    }
  };
  video.onended = () => finish("ended");
  video.onerror = () => {
    if (myGeneration === generation && currentItem === item) {
      failItem(item, "video failed: " + (video.error?.message ?? "unknown"));
    }
  };
  // A fixed durationMs (rare for video) also bounds the item.
  if (item.durationMs && playbackAuthority === "local") {
    itemTimer = window.setTimeout(
      () => finish("duration-timer"),
      item.durationMs,
    );
  }
  // The one intentional seek: start at the synchronized (or trimmed) offset.
  // Drift correction never seeks merely because the occurrence changed, so this
  // is the only reposition a healthy item performs.
  video.currentTime = startS;
  fillBackLayer(video);
  video.src = item.src;
  if (startS > 0) {
    video.addEventListener(
      "loadedmetadata",
      () => {
        video.currentTime = startS;
      },
      { once: true },
    );
  }
}

function renderWebsite(item: RendererItem, myGeneration: number): void {
  const config = item.website;
  if (!config) {
    failItem(item, "website configuration missing");
    return;
  }

  const webview = document.createElement("webview");
  const policy = config.cookiePolicy;
  const partition =
    policy === "disabled"
      ? `tilecast-websites-disabled-${item.id}-${myGeneration}`
      : policy === "first_and_third_party"
        ? "persist:tilecast-websites-all"
        : "persist:tilecast-websites-first-party";
  webview.setAttribute("partition", partition);
  webview.setAttribute("allowpopups", "false");
  webview.setAttribute(
    "webpreferences",
    [
      `javascript=${config.javascriptEnabled ? "yes" : "no"}`,
      `webSecurity=yes`,
      `domStorage=${config.domStorageEnabled ? "yes" : "no"}`,
    ].join(","),
  );
  if (config.customUserAgent.trim()) {
    webview.setAttribute("useragent", config.customUserAgent.trim());
  }
  webview.style.backgroundColor = config.backgroundColor || "#000";
  let loaded = false;
  let failed = false;

  const showFallback = (reason: string) => {
    if (failed || myGeneration !== generation || currentItem !== item) {
      return;
    }
    failed = true;
    tilecast.reportPlaybackError(item.id, "website failed: " + reason);
    if (config.failureBehavior === "skip" || !config.fallbackSrc) {
      // Advance without counting a hard failure spiral; websites fail for
      // reasons that never affect cached media.
      if (completion.complete("failure") !== "ignore") {
        advance();
      }
      return;
    }
    const fallbackImage = document.createElement("img");
    fallbackImage.style.objectFit = "contain";
    fallbackImage.src = config.fallbackSrc;
    fallbackImage.onload = () => {
      swapLayers();
      tilecast.reportProgress(item.id, "image-shown");
    };
    fillBackLayer(fallbackImage);
    scheduleItemCompletion(item, item.durationMs ?? 60_000);
  };

  websiteLoadTimer = window.setTimeout(
    () => showFallback("load timeout"),
    Math.max(config.loadTimeoutSeconds, 5) * 1_000,
  );
  const loadTimeout = websiteLoadTimer;

  webview.addEventListener("did-finish-load", () => {
    if (myGeneration !== generation || currentItem !== item || failed) {
      return;
    }
    window.clearTimeout(loadTimeout);
    if (!loaded) {
      loaded = true;
      if (config.zoomPercent && config.zoomPercent !== 100) {
        try {
          (
            webview as unknown as { setZoomFactor(f: number): void }
          ).setZoomFactor(config.zoomPercent / 100);
        } catch {
          /* zoom is cosmetic */
        }
      }
      if (config.scrollX || config.scrollY) {
        try {
          (
            webview as unknown as {
              executeJavaScript(code: string): Promise<unknown>;
            }
          ).executeJavaScript(
            `window.scrollTo(${Math.trunc(config.scrollX)},${Math.trunc(config.scrollY)})`,
          );
        } catch {
          /* scroll position is cosmetic */
        }
      }
      swapLayers();
      consecutiveFailures = 0;
    } else {
      tilecast.reportWebsiteRecovered();
    }
    tilecast.reportProgress(item.id, "website-loaded");
    // Healthy website: keep reporting while it stays on screen.
    if (stillImageTicker === null) {
      stillImageTicker = window.setInterval(() => {
        tilecast.reportProgress(item.id, "website-alive");
      }, 30_000);
    }
  });
  webview.addEventListener("did-fail-load", (event) => {
    const e = event as unknown as { errorCode: number; isMainFrame: boolean };
    if (e.isMainFrame && e.errorCode !== -3 /* aborted */) {
      window.clearTimeout(loadTimeout);
      showFallback("error " + e.errorCode);
    }
  });
  webview.addEventListener("crashed", () => {
    window.clearTimeout(loadTimeout);
    showFallback("renderer crashed");
  });

  if (config.reloadPolicy === "interval" && config.refreshIntervalSeconds) {
    websiteRefreshTimer = window.setInterval(
      () => {
        try {
          (webview as unknown as { reload(): void }).reload();
        } catch {
          /* reload best-effort */
        }
      },
      Math.max(config.refreshIntervalSeconds, 30) * 1_000,
    );
  }

  scheduleItemCompletion(item, item.durationMs ?? 60_000);
  fillBackLayer(webview);
  webview.setAttribute("src", item.src);
}

// ------------------------------------------------------------- app states

function showSetup(): void {
  showMessage(`
    <img class="brand-logo" src="tilecast-logo-white.svg" alt="Tilecast" />
    <p>Choose your Tilecast server, or enter its address.</p>
    <div id="discovered" style="display:flex;flex-direction:column;gap:10px;width:60%;"></div>
    <input id="setup-input" type="url" placeholder="https://signage.example.org" autofocus />
    <div id="setup-error"></div>
  `);
  const input = document.getElementById("setup-input") as HTMLInputElement;
  const error = document.getElementById("setup-error") as HTMLDivElement;
  const discovered = document.getElementById("discovered") as HTMLDivElement;
  const knownUrls = new Set<string>();

  const submit = (url: string) => {
    void tilecast.submitServerUrl(url).then((result) => {
      if (!result.ok) {
        error.textContent = result.error ?? "Invalid address";
      }
    });
  };

  const addServer = (server: { name: string; serverUrl: string }) => {
    if (knownUrls.has(server.serverUrl)) {
      return;
    }
    knownUrls.add(server.serverUrl);
    const button = document.createElement("button");
    button.textContent = `${server.name} — ${server.serverUrl}`;
    button.style.cssText =
      "font-size:24px;padding:14px 20px;border-radius:8px;border:1px solid #4C8BF5;background:#16202B;color:#fff;cursor:pointer;text-align:left;";
    button.addEventListener("click", () => submit(server.serverUrl));
    discovered.appendChild(button);
  };

  input.focus();
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      submit(input.value);
    }
  });

  tilecast.onDiscoveredServer(addServer);
  void tilecast
    .listDiscoveredServers()
    .then((servers) => servers.forEach(addServer));
}

function present(presentation: RendererPresentation): void {
  // `sleep` is the player's own off-hours state, and it is the only thing that
  // produces it. The Noise Meter follows it rather than evaluating a second
  // copy of the active-hours schedule that could disagree with playback.
  const awake = presentation.state !== "sleep";
  if (awake !== playerAwake) {
    playerAwake = awake;
    applyNoiseMeterLifecycle();
  }
  switch (presentation.state) {
    case "setup":
      showSetup();
      break;
    case "pairing":
      showMessage(`
        <img class="brand-logo" src="tilecast-logo-white.svg" alt="Tilecast" />
        <h1>${escapeHtml(presentation.organizationName ?? "Tilecast")}</h1>
        <p>Approve this screen in Tilecast Studio with the code below.</p>
        <div class="code">${escapeHtml(presentation.code ?? "")}</div>
        <p>${escapeHtml(presentation.approvalUrl ?? "")}</p>
      `);
      break;
    case "idle":
      showBrandedMessage(presentation);
      break;
    case "disabled":
      showBrandedMessage(presentation);
      break;
    case "unavailable":
      showBrandedMessage(presentation);
      break;
    case "safe-mode":
      showMessage(`
        <h1>Safe mode</h1>
        <p>${escapeHtml(presentation.reason ?? "")}</p>
        <p>The player remains connected and accepts commands from Tilecast Studio.</p>
      `);
      break;
    case "sleep":
      // Outside active hours: true black, all media torn down, no decoding.
      showMessage("");
      break;
    case "playing":
      startPlaying(presentation);
      break;
    case "external-presentation": {
      // UxPlay owns the single-screen window and GStreamer owns the group
      // receiver window once connected. Keeping Electron's message layer
      // empty in that state prevents a stale ready page from covering either
      // external surface. Before connection the ready page is the only
      // visible Tilecast surface.
      if (presentation.connected) {
        showMessage("");
        break;
      }
      const expires = presentation.expiresAt
        ? new Date(presentation.expiresAt).toLocaleString()
        : "the scheduled end time";
      // While the gateway is joining its Presentation Network there is no PIN to
      // offer yet: the receiver is deliberately not advertised until the network
      // is up, so telling someone to pick it from their AirPlay list would be
      // wrong. Say what is happening instead.
      //
      // The copy is deliberately generic. Neither the network's name, its SSID,
      // nor anything resembling a credential belongs on a screen that a room full
      // of people can see; Studio, where an operator is already signed in, shows
      // the named progress.
      if (presentation.presentationNetwork === "joining") {
        showMessage(`
          <h1>Preparing to Present</h1>
          <h2>${escapeHtml(presentation.receiverName ?? "Tilecast AirPlay")}</h2>
          <p>Connecting to the presentation network…</p>
          <p>This display will appear in Screen Mirroring shortly.</p>
        `);
        break;
      }
      if (presentation.presentationNetwork === "failed") {
        showMessage(`
          <h1>Cannot Present</h1>
          <h2>${escapeHtml(presentation.receiverName ?? "Tilecast AirPlay")}</h2>
          <p>This display could not join the presentation network.</p>
          <p>Ask an administrator to check Presentation Networks in Tilecast Studio.</p>
        `);
        break;
      }
      showMessage(`
        <h1>Ready to Present</h1>
        <h2>${escapeHtml(presentation.receiverName ?? "Tilecast AirPlay")}</h2>
        <div class="code">${escapeHtml(presentation.pin ?? "")}</div>
        <p>On iPhone, iPad, or Mac, choose Screen Mirroring and select this receiver.</p>
        <p>Available until ${escapeHtml(expires)}.</p>
        <p>Waiting for a presenter…</p>
      `);
      break;
    }
    default:
      break;
  }
}

// The bridge is injected by the preload via contextBridge. If it is missing,
// the preload failed to load (e.g. a sandboxed renderer cannot require its
// core modules). Surface that on screen instead of throwing at the first
// tilecast.* call, which would leave a headless kiosk silently black with no
// way to diagnose it in the field.
if (typeof tilecast === "undefined") {
  showMessage(`
    <h1>Display bridge unavailable</h1>
    <p>The player UI could not connect to the runtime. The device will
    keep trying; if this persists, check the player logs.</p>
  `);
  throw new Error("tilecast bridge missing: preload did not load");
}

tilecast.onPresent(present);
tilecast.onPlugins((payload) => {
  activePlugins = payload.plugins;
  pluginClockOffsetMs = Number.isFinite(payload.clockOffsetMs)
    ? payload.clockOffsetMs
    : 0;
  // The meter owns hardware, so it is reconciled against the new manifest
  // before the surface is drawn: an instance that has gone away has to release
  // the microphone, not merely stop being painted.
  syncNoiseMeter();
  updatePluginSurface();
  if (pluginTimer !== null) window.clearInterval(pluginTimer);
  pluginTimer = window.setInterval(updatePluginSurface, 1_000);
});

// A reload replaces this renderer, and the microphone has to go with it rather
// than being left for whatever the old page's teardown happens to collect.
window.addEventListener("pagehide", () => noiseMeterCapture?.stop());

tilecast.onIdentify(({ name, durationSeconds }) => {
  identifyEl.textContent = name;
  identifyEl.classList.add("visible");
  window.setTimeout(
    () => identifyEl.classList.remove("visible"),
    durationSeconds * 1_000,
  );
});

tilecast.onRetryItem(() => {
  if (currentItem) {
    void renderItem(currentItem, generation);
  }
});

tilecast.onSkipItem(() => {
  if (playbackAuthority === "shared") {
    // A grouped screen cannot skip on its own: the shared timeline would snap
    // it back within milliseconds, which is the visible glitch being fixed.
    return;
  }
  advance();
});
