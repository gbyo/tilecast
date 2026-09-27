/**
 * One remote web model for every source: Website assets, schema-13
 * `presentation.kind = "web"` Widgets and YouTube Widgets, whether they play
 * as a root item or inside a Layout zone.
 *
 * Host policy (what the page may do) and presentation policy (timers,
 * fallback, completion) stay separate: `content` goes to the host,
 * `presentation` stays in the runtime. Every value is bounded here, and the
 * host checks it again.
 */
import type {
  RemoteWebCookiePolicyV1,
  RemoteWebPageContentV1,
  RemoteWebPresentationV1,
  RemoteWebYouTubeContentV1,
  RuntimeItem,
  RuntimeRemoteWebSpecV1,
  RuntimeWebsiteConfig,
} from "../host/contract";

export const MAX_URL = 2048;
export const MAX_HOSTS = 25;
export const MIN_RELOAD_SECONDS = 30;
export const MAX_RELOAD_SECONDS = 86_400;
export const MIN_LOAD_TIMEOUT_SECONDS = 5;
export const MAX_LOAD_TIMEOUT_SECONDS = 120;
export const MAX_WARM_SECONDS = 300;
/** YouTube's embedded-player minimum viewport (Required Minimum Functionality). */
export const YOUTUBE_MIN_EDGE = 200;
const DEFAULT_BACKGROUND = "#0E141B";
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,128}$/;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/;
const COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const HOST = /^[a-z0-9.-]{1,253}$/;

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function cookiePolicy(value: unknown): RemoteWebCookiePolicyV1 {
  return value === "disabled" || value === "first_and_third_party"
    ? value
    : "first_party";
}

/** Lowercase, no trailing dot, deduplicated, bounded. */
export function normalizeHosts(hosts: unknown, url: string): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    const host = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");
    if (HOST.test(host) && !out.includes(host) && out.length < MAX_HOSTS) {
      out.push(host);
    }
  };
  if (Array.isArray(hosts)) hosts.forEach(add);
  if (out.length === 0) {
    try {
      add(new URL(url).hostname);
    } catch {
      /* no host: the URL check refuses it */
    }
  }
  return out;
}

/** http(s) with a host and no user information, at most MAX_URL bytes. */
export function isRemoteUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_URL) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

/**
 * Website failure policies, shared by every remote web surface. Unknown
 * values fail safe as a placeholder, never as a skip: dropping an item
 * silently is the one behavior that must stay explicit.
 */
export const FAILURE_BEHAVIORS = [
  "skip",
  "fallback_image",
  "placeholder",
  "last_success",
] as const;

export type FailureBehavior = (typeof FAILURE_BEHAVIORS)[number];

export function normalizeFailureBehavior(value: unknown): FailureBehavior {
  return (FAILURE_BEHAVIORS as readonly string[]).includes(String(value))
    ? (value as FailureBehavior)
    : "placeholder";
}

function presentation(
  partial: Partial<RemoteWebPresentationV1>,
): RemoteWebPresentationV1 {
  const reload = partial.reloadIntervalSeconds;
  return {
    loadTimeoutSeconds: clamp(
      partial.loadTimeoutSeconds,
      MIN_LOAD_TIMEOUT_SECONDS,
      MAX_LOAD_TIMEOUT_SECONDS,
      20,
    ),
    reloadIntervalSeconds:
      reload == null || !Number.isFinite(Number(reload)) || Number(reload) <= 0
        ? null
        : clamp(reload, MIN_RELOAD_SECONDS, MAX_RELOAD_SECONDS, 60),
    lifecycle:
      partial.lifecycle === "keep_warm" ? "keep_warm" : "destroy_on_hide",
    warmSeconds: clamp(partial.warmSeconds, 0, MAX_WARM_SECONDS, 0),
    onlineOnly: partial.onlineOnly === true,
    failureBehavior: normalizeFailureBehavior(partial.failureBehavior),
    fallbackSrc: partial.fallbackSrc ?? null,
    playUntilEnd: partial.playUntilEnd === true,
  };
}

/** A Website asset's server configuration (the Electron player's item shape). */
export function specFromWebsite(
  src: string,
  config: RuntimeWebsiteConfig,
): RuntimeRemoteWebSpecV1 | null {
  if (!isRemoteUrl(src)) return null;
  const content: RemoteWebPageContentV1 = {
    kind: "page",
    url: src,
    allowedHosts: normalizeHosts(config.allowedHosts, src),
    javascriptEnabled: config.javascriptEnabled !== false,
    domStorageEnabled: config.domStorageEnabled !== false,
    cookiePolicy: cookiePolicy(config.cookiePolicy),
    userAgent: /^[\x20-\x7e]{0,256}$/.test(config.customUserAgent ?? "")
      ? (config.customUserAgent ?? "").trim()
      : "",
    zoomPercent: clamp(config.zoomPercent, 25, 500, 100),
    scrollX: clamp(config.scrollX, 0, 100_000, 0),
    scrollY: clamp(config.scrollY, 0, 100_000, 0),
    backgroundColor: COLOR.test(config.backgroundColor ?? "")
      ? config.backgroundColor
      : DEFAULT_BACKGROUND,
  };
  return {
    content,
    presentation: presentation({
      loadTimeoutSeconds: config.loadTimeoutSeconds,
      reloadIntervalSeconds:
        config.reloadPolicy === "interval"
          ? config.refreshIntervalSeconds
          : null,
      failureBehavior: config.failureBehavior,
      fallbackSrc: config.fallbackSrc,
    }),
  };
}

/** The server-compiled `presentation.web` of a schema-13 web Widget. */
export interface WebDescriptor {
  mode?: string;
  url?: string;
  allowedHosts?: string[];
  onlineOnly?: boolean;
  fallbackBehavior?: string;
  loadTimeoutSeconds?: number;
  lifecycle?: string;
  warmSeconds?: number;
  reload?: { mode?: string; intervalSeconds?: number } | null;
}

export function specFromWebDescriptor(
  web: WebDescriptor | null | undefined,
): RuntimeRemoteWebSpecV1 | null {
  if (!web || web.mode !== "remote" || !web.url || !isRemoteUrl(web.url)) {
    return null;
  }
  return {
    content: {
      kind: "page",
      url: web.url,
      allowedHosts: normalizeHosts(web.allowedHosts, web.url),
      // The reference players' defaults for a web Widget.
      javascriptEnabled: true,
      domStorageEnabled: true,
      cookiePolicy: "first_party",
      userAgent: "",
      zoomPercent: 100,
      scrollX: 0,
      scrollY: 0,
      backgroundColor: DEFAULT_BACKGROUND,
    },
    presentation: presentation({
      loadTimeoutSeconds: web.loadTimeoutSeconds,
      reloadIntervalSeconds:
        web.reload?.mode === "periodic" ? web.reload.intervalSeconds : null,
      lifecycle: web.lifecycle as RemoteWebPresentationV1["lifecycle"],
      warmSeconds: web.warmSeconds,
      onlineOnly: web.onlineOnly,
      failureBehavior: web.fallbackBehavior,
      fallbackSrc: null,
    }),
  };
}

/**
 * A YouTube Widget's normalized provider configuration (the server's
 * YouTubeConfig). `fallbackSrc` is the media URI of its fallback image, if
 * the manifest carries one.
 */
export function specFromYouTube(
  config: Record<string, unknown>,
  fallbackSrc: string | null,
): RuntimeRemoteWebSpecV1 | null {
  const video = String(config["videoId"] ?? "");
  const playlist = String(config["playlistId"] ?? "");
  const isPlaylist = config["kind"] === "playlist" || (!video && !!playlist);
  const videoId = !isPlaylist && YOUTUBE_ID.test(video) ? video : null;
  const playlistId = isPlaylist && YOUTUBE_ID.test(playlist) ? playlist : null;
  if (!videoId && !playlistId) return null;
  const start = clamp(config["startSeconds"], 0, 86_400, 0);
  const endRaw = config["endSeconds"];
  const end =
    endRaw == null ? null : clamp(endRaw, start + 1, 2 * 86_400, start + 1);
  const language = String(config["captionLanguage"] ?? "");
  const content: RemoteWebYouTubeContentV1 = {
    kind: "youtube",
    videoId,
    playlistId,
    startSeconds: start,
    endSeconds: end,
    loop: config["loop"] === true,
    muted: config["muted"] === true,
    volume: clamp(config["volume"], 0, 100, 100),
    captions: config["captions"] === true,
    captionLanguage: LANGUAGE.test(language) ? language : "",
    controls: config["controls"] === true,
  };
  const fixed = Number(config["fixedDurationSeconds"]);
  const failure = String(config["failureBehavior"] || "placeholder");
  return {
    content,
    presentation: presentation({
      loadTimeoutSeconds: 30,
      failureBehavior:
        failure === "fallback_image" ? "fallback_image" : failure,
      fallbackSrc,
      playUntilEnd:
        config["playlistPlaybackMode"] !== "fixed_duration" &&
        !(Number.isFinite(fixed) && fixed > 0) &&
        !content.loop,
    }),
  };
}

/**
 * The remote web spec of a website or youtube item: `remoteWeb` when the
 * projection made one, otherwise the item's Website configuration.
 */
export function remoteWebSpecOf(
  item: RuntimeItem,
): RuntimeRemoteWebSpecV1 | null {
  if (item.remoteWeb && typeof item.remoteWeb === "object") {
    return item.remoteWeb;
  }
  if (item.website) return specFromWebsite(item.src, item.website);
  return null;
}

/**
 * The privacy-enhanced embed URL for hosts that load YouTube as a plain page
 * (the Electron <webview> adapter). Documented embed parameters only.
 */
export function youtubeEmbedUrl(content: RemoteWebYouTubeContentV1): string {
  const params = new URLSearchParams();
  params.set("autoplay", "1");
  params.set("playsinline", "1");
  params.set("mute", content.muted ? "1" : "0");
  params.set("controls", content.controls ? "1" : "0");
  params.set("rel", "0");
  params.set("cc_load_policy", content.captions ? "1" : "0");
  if (content.captions && content.captionLanguage) {
    params.set("cc_lang_pref", content.captionLanguage);
  }
  if (content.startSeconds > 0)
    params.set("start", String(content.startSeconds));
  if (content.endSeconds !== null)
    params.set("end", String(content.endSeconds));
  if (content.playlistId) {
    params.set("listType", "playlist");
    params.set("list", content.playlistId);
    if (content.loop) params.set("loop", "1");
    return `https://www.youtube-nocookie.com/embed?${params.toString()}`;
  }
  if (content.loop) {
    params.set("loop", "1");
    params.set("playlist", content.videoId!);
  }
  return `https://www.youtube-nocookie.com/embed/${content.videoId}?${params.toString()}`;
}
