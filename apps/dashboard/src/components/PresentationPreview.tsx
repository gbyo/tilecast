import {
  Film,
  Image as ImageIcon,
  LayoutTemplate,
  PanelsTopLeft,
  ListVideo,
  Tags,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  LayoutSummary,
  Playlist,
  PlaylistPreviewItem,
} from "../api/types";
import "./PresentationPreview.css";

export function PlaylistPreview({
  playlist,
}: {
  playlist: Pick<Playlist, "itemCount" | "sourceType" | "previewItems">;
}) {
  const { t } = useTranslation("screens");
  const previewItems = (playlist.previewItems ?? []).slice(0, 4);
  if (previewItems.length === 0) {
    const Icon = playlist.sourceType === "tag" ? Tags : ListVideo;
    return (
      <span className="playlist-library-preview playlist-library-preview--empty">
        <Icon size={30} aria-hidden="true" />
        <span>
          {playlist.itemCount === 0
            ? t("preview.noContent")
            : t("preview.unavailable")}
        </span>
      </span>
    );
  }
  return (
    <span
      className={`playlist-library-preview playlist-library-preview--count-${previewItems.length}`}
      aria-hidden="true"
    >
      {previewItems.map((item) => (
        <PlaylistPreviewTile key={item.id} item={item} />
      ))}
    </span>
  );
}

function PlaylistPreviewTile({ item }: { item: PlaylistPreviewItem }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.thumbnailUrl]);
  const Icon =
    item.type === "video"
      ? Film
      : item.type === "widget"
        ? PanelsTopLeft
        : item.type === "layout"
          ? LayoutTemplate
          : ImageIcon;
  return (
    <span className="playlist-library-preview__tile" title={item.name}>
      {item.thumbnailUrl && !failed ? (
        <img
          src={item.thumbnailUrl}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="playlist-library-preview__fallback">
          <Icon size={23} aria-hidden="true" />
          <small>{item.name}</small>
        </span>
      )}
    </span>
  );
}

export function LayoutPreview({
  layout,
}: {
  layout: Pick<LayoutSummary, "previewImageUrl" | "orientation">;
}) {
  const { t } = useTranslation("screens");
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [layout.previewImageUrl]);
  return (
    <span
      className="layout-library-preview"
      data-orientation={layout.orientation}
    >
      {!layout.previewImageUrl || failed ? (
        <span className="layout-library-preview-fallback" aria-hidden="true">
          <LayoutTemplate size={30} />
          <strong>{t("preview.unavailable")}</strong>
          <small>{t("preview.openLayoutHint")}</small>
        </span>
      ) : (
        <img
          className="layout-library-thumbnail"
          src={layout.previewImageUrl}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
