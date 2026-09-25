import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  Copy,
  ExternalLink,
  History,
  MoreHorizontal,
  Send,
  Settings2,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Playlist } from "../../api/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Spinner } from "../ui/spinner";
import { playlistDurationLabel } from "./playlistEditorModel";

export type PlaylistPublicationState =
  "published" | "unpublished-changes" | "draft";

export function playlistPublicationState(
  playlist: Playlist,
): PlaylistPublicationState {
  if (playlist.publishedRevision == null) return "draft";
  return playlist.hasUnpublishedChanges ? "unpublished-changes" : "published";
}

const publicationBadge = {
  published: {
    labelKey: "header.statusPublished",
    Icon: CircleCheck,
    variant: "secondary",
  },
  "unpublished-changes": {
    labelKey: "header.unpublished",
    Icon: CircleDot,
    variant: "outline",
  },
  draft: {
    labelKey: "header.statusDraft",
    Icon: CircleDashed,
    variant: "outline",
  },
} as const;

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
  const state = playlistPublicationState(playlist);
  const badge = publicationBadge[state];
  const itemCount = playlist.items?.length ?? playlist.itemCount;

  return (
    <header className="flex flex-col items-start gap-x-4 gap-y-3 sm:flex-row sm:justify-between">
      <div className="grid w-full min-w-0 gap-1.5 sm:flex-1">
        <h1 className="line-clamp-2 text-2xl font-semibold tracking-tight break-words sm:truncate">
          {playlist.name}
        </h1>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <Badge variant={badge.variant}>
            <badge.Icon aria-hidden="true" />
            {t(badge.labelKey)}
          </Badge>
          <span className="tabular-nums">
            {t("count.items", { count: itemCount })} ·{" "}
            {playlistDurationLabel(playlist.items, t)}
            {sourceType === "tag" && ` · ${t("header.sourceTag")}`}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={onPreview}>
          <ExternalLink aria-hidden="true" />
          {t("header.preview")}
        </Button>
        {canSubmit && (
          <Button
            type="button"
            disabled={state === "published" || publishPending}
            aria-busy={publishPending || undefined}
            onClick={onPublish}
          >
            {publishPending ? (
              <Spinner aria-hidden="true" />
            ) : (
              <Send aria-hidden="true" />
            )}
            {canPublish ? t("header.publish") : t("header.submitReview")}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t("header.moreActions")}
              />
            }
          >
            <MoreHorizontal aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-48"
            aria-label={t("header.actionsMenu")}
          >
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onOpenDetails}>
                <Settings2 aria-hidden="true" />
                {t("header.details")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenHistory}>
                <History aria-hidden="true" />
                {t("header.history")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {canManage && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={onDuplicate}>
                    <Copy aria-hidden="true" />
                    {t("header.menu.duplicate")}
                  </DropdownMenuItem>
                  {canDelete && (
                    <DropdownMenuItem variant="destructive" onClick={onDelete}>
                      <Trash2 aria-hidden="true" />
                      {t("header.menu.delete")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
