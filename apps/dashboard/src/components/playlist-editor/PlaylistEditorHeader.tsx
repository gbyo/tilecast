import {
  Copy,
  ExternalLink,
  History,
  MoreHorizontal,
  Settings2,
  Send,
  Trash2,
  ArrowLeft,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { Playlist } from "../../api/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { playlistDurationLabel } from "./playlistEditorModel";

export function PlaylistEditorHeader({
  playlist,
  sourceType,
  canManage,
  canDelete,
  canSubmit,
  canPublish,
  publishPending,
  onPreview,
  onPublish,
  onOpenHistory,
  onOpenDetails,
  onDuplicate,
  onDelete,
}: {
  playlist: Playlist;
  sourceType: "static" | "tag";
  canManage: boolean;
  canDelete: boolean;
  canSubmit: boolean;
  canPublish: boolean;
  publishPending: boolean;
  onPreview: () => void;
  onPublish: () => void;
  onOpenHistory: () => void;
  onOpenDetails: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("playlists");
  const hasChanges = Boolean(
    playlist.hasUnpublishedChanges ||
    playlist.draftRevision !== playlist.publishedRevision,
  );
  const isPublished = !hasChanges && playlist.publishedRevision != null;
  const duration = playlistDurationLabel(playlist.items, t);

  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid min-w-0 gap-1">
        <Link
          to="/playlists"
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={15} aria-hidden="true" />
          {t("header.back")}
        </Link>
        <h1 className="truncate text-2xl font-semibold tracking-tight">
          {playlist.name}
        </h1>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <Badge variant={isPublished ? "default" : "secondary"}>
            {isPublished
              ? t("header.statusPublished")
              : t("header.statusDraft")}
          </Badge>
          <span>{t("count.items", { count: playlist.itemCount })}</span>
          <span>{duration}</span>
          {sourceType === "tag" && <span>{t("header.sourceTag")}</span>}
          {hasChanges && (
            <span className="font-medium text-amber-600 dark:text-amber-400">
              {t("header.unpublished")}
            </span>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={onPreview}>
          <ExternalLink size={15} aria-hidden="true" />
          {t("header.preview")}
        </RheaButton>
        {canSubmit && (
          <Button
            type="button"
            disabled={!hasChanges || publishPending}
            onClick={onPublish}
          >
            <Send size={15} aria-hidden="true" />
            {publishPending
              ? t("header.publishing")
              : canPublish
                ? t("header.publish")
                : t("header.submitReview")}
          </RheaButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex size-8 items-center justify-center rounded-xl hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
            aria-label={t("header.moreActions")}
          >
            <MoreHorizontal size={18} aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" aria-label={t("header.actionsMenu")}>
            <DropdownMenuItem onClick={onOpenHistory}>
              <History size={16} aria-hidden="true" />
              {t("header.history")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenDetails}>
              <Settings2 size={16} aria-hidden="true" />
              {t("header.details")}
            </DropdownMenuItem>
            {canManage && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onDuplicate}>
                  <Copy size={16} aria-hidden="true" />
                  {t("header.duplicate")}
                </DropdownMenuItem>
                {canDelete && (
                  <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    <Trash2 size={16} aria-hidden="true" />
                    {t("header.delete")}
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
