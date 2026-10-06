import type { LayoutSummary, Playlist } from "../api/types";
import type { SchedulesT } from "./scheduleBuilderModel";
import type { PresentationChoice } from "./scheduleEditorModel";

export function presentationMeta(
  kind: PresentationChoice["kind"],
  playlist: Playlist | undefined,
  layout: LayoutSummary | undefined,
  t: SchedulesT,
) {
  if (kind === "layout") {
    return layout?.publishedRevision
      ? t("editor.presentation.layoutMeta", {
          revision: layout.publishedRevision,
        })
      : t("editor.presentation.layoutKind");
  }
  if (!playlist) return t("editor.presentation.playlistKind");
  if (!playlist.itemCount) return t("editor.presentation.playlistEmpty");
  return t("editor.presentation.playlistMeta", {
    count: playlist.itemCount,
    duration: playlistDuration(playlist, t),
  });
}

/** "4 min 20 sec", or why there is no total: nothing in it, or live-length items. */
export function playlistDuration(playlist: Playlist, t: SchedulesT) {
  if (!playlist.items?.length) return t("editor.presentation.durationVaries");
  const seconds = playlist.items.reduce(
    (total, item) =>
      total +
      (item.durationMs
        ? item.durationMs / 1000
        : (item.assetDurationSeconds ?? 0)),
    0,
  );
  if (!seconds) return t("editor.presentation.durationVaries");
  // Round first, so 59.6 seconds is a minute and not "0 min 60 sec".
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return minutes
    ? `${t("duration.minutes", { count: minutes })}${remainder ? ` ${t("duration.seconds", { count: remainder })}` : ""}`
    : t("duration.seconds", { count: remainder });
}
