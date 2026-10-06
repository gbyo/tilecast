/** Where an editor trip started, which names the Back button. */
export type Origin = "layout" | "playlist" | "media" | "dataSources" | "screen";

export function originOf(returnTo: string | null): Origin | null {
  if (!returnTo) return null;
  if (returnTo.startsWith("/layouts/")) return "layout";
  if (returnTo.startsWith("/playlists/")) return "playlist";
  if (returnTo.startsWith("/assets")) return "media";
  if (returnTo.startsWith("/data-sources")) return "dataSources";
  if (returnTo.startsWith("/screens")) return "screen";
  return null;
}

export { shortcutLabel } from "@/hooks/use-save-shortcut";
