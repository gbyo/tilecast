/**
 * Web integrations preview through the Server's presentation compiler,
 * which turns their configuration into the address a sandboxed frame
 * loads. Some providers store values the Server derives on save; a draft
 * has not been saved yet, so this answers one narrow question per provider:
 * what does the compiler need to preview this draft? It never shapes what
 * is saved.
 */

const youtubeId = /^[A-Za-z0-9_-]{6,128}$/;

/** Mirrors the Server's YouTube URL parsing (media.youtubeWidgetProvider). */
export function youtubePreviewIds(raw: unknown): {
  videoId?: string;
  playlistId?: string;
} {
  if (typeof raw !== "string") return {};
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return {};
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let videoId: string;
  let playlistId = "";
  if (host === "youtu.be") {
    videoId = url.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  } else if (
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com"
  ) {
    videoId = url.searchParams.get("v") ?? "";
    playlistId = url.searchParams.get("list") ?? "";
  } else {
    return {};
  }
  if (url.pathname.includes("/playlist") || (playlistId && !videoId))
    return youtubeId.test(playlistId) ? { playlistId } : {};
  return youtubeId.test(videoId) ? { videoId } : {};
}

const adapters: Record<
  string,
  (configuration: Record<string, unknown>) => Record<string, unknown>
> = {
  youtube: (configuration) => {
    // Derived ids from an earlier save never outlive an edited address.
    const rest = { ...configuration };
    delete rest["videoId"];
    delete rest["playlistId"];
    return { ...rest, ...youtubePreviewIds(configuration["url"]) };
  },
};

export function webPreviewConfiguration(
  provider: string,
  configuration: Record<string, unknown>,
): Record<string, unknown> {
  return adapters[provider]?.(configuration) ?? configuration;
}
