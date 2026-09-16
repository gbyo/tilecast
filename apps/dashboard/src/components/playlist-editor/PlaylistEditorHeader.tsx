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
import { Link } from "react-router";
import { Button, PageHeader, Popover, StatusBadge } from "../ui";
import type { Playlist } from "../../api/types";
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
  const hasChanges = Boolean(
    playlist.hasUnpublishedChanges ||
    playlist.draftRevision !== playlist.publishedRevision,
  );
  const isPublished = !hasChanges && playlist.publishedRevision != null;
  const duration = playlistDurationLabel(playlist.items);

  return (
    <PageHeader
      className="playlist-editor-header"
      eyebrow={
        <Link className="playlist-editor-header__back" to="/playlists">
          <ArrowLeft size={15} aria-hidden="true" />
          Playlists
        </Link>
      }
      title={playlist.name}
      description={
        <span className="playlist-editor-header__summary">
          <StatusBadge
            label={isPublished ? "Published" : "Draft"}
            tone={isPublished ? "success" : "neutral"}
          />
          <span>{playlist.itemCount} items</span>
          <span>{duration}</span>
          {sourceType === "tag" && <span>Tag-driven</span>}
          {hasChanges && (
            <span className="playlist-editor-header__unpublished">
              Unpublished changes
            </span>
          )}
        </span>
      }
      actions={
        <>
          <Button variant="quiet" onClick={onPreview}>
            <ExternalLink size={15} aria-hidden="true" />
            Preview
          </Button>
          {canSubmit && (
            <Button
              variant="primary"
              loading={publishPending}
              onClick={onPublish}
              disabled={!hasChanges}
            >
              <Send size={15} aria-hidden="true" />
              {canPublish ? "Publish" : "Submit for review"}
            </Button>
          )}
          <Popover
            label="Playlist actions"
            mode="menu"
            align="end"
            width="220px"
            trigger={(trigger) => (
              <button
                type="button"
                className="icon-button playlist-editor-header__menu-trigger"
                aria-label="More playlist actions"
                title="More playlist actions"
                {...trigger}
              >
                <MoreHorizontal size={18} aria-hidden="true" />
              </button>
            )}
          >
            {(close) => (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="playlist-editor-menu-item"
                  onClick={() => {
                    close();
                    onOpenHistory();
                  }}
                >
                  <History size={16} aria-hidden="true" />
                  History
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="playlist-editor-menu-item"
                  onClick={() => {
                    close();
                    onOpenDetails();
                  }}
                >
                  <Settings2 size={16} aria-hidden="true" />
                  Playlist details
                </button>
                {canManage && (
                  <>
                    <hr className="playlist-editor-menu-divider" />
                    <button
                      type="button"
                      role="menuitem"
                      className="playlist-editor-menu-item"
                      onClick={() => {
                        close();
                        onDuplicate();
                      }}
                    >
                      <Copy size={16} aria-hidden="true" />
                      Duplicate playlist
                    </button>
                    {canDelete && (
                      <button
                        type="button"
                        role="menuitem"
                        className="playlist-editor-menu-item playlist-editor-menu-item--danger"
                        onClick={() => {
                          close();
                          onDelete();
                        }}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                        Delete playlist
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </Popover>
        </>
      }
    />
  );
}
