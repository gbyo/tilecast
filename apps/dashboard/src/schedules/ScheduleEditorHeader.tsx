/**
 * The editor's controls in the shared Studio header: Back, the outcome review
 * when it has no pane of its own, save state, Save, and the schedule's other
 * actions. The header's last breadcrumb shows the draft name.
 */
import { ArrowLeft, ListChecks } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { ActionMenuButton } from "../components/studio/ActionMenu";
import {
  EditorHeaderPortal,
  useEditorHeaderRename,
  useEditorHeaderTitle,
} from "../components/studio/EditorHeaderSlots";
import { EditorSaveStatus } from "../components/studio/EditorSaveStatus";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { Spinner } from "../components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { useNarrowHeader } from "../components/content/widget-editor/header/useNarrowHeader";
import { shortcutLabel } from "../hooks/use-save-shortcut";
import { ScheduleDeleteDialog } from "./ScheduleDeleteDialog";
import type { ScheduleEditorSession } from "./useScheduleEditorSession";
import { attentionCount } from "./useSchedulePreflight";

export function ScheduleEditorHeader({
  session,
  csrf,
  canManage,
  compact: phone,
  showReview,
  onReview,
}: {
  session: ScheduleEditorSession;
  csrf: string;
  canManage: boolean;
  compact: boolean;
  /** Whether the outcome has no pane of its own, so the header offers it. */
  showReview: boolean;
  onReview: () => void;
}) {
  const { t } = useTranslation("schedules");
  const navigate = useNavigate();
  // Compact forms apply on a phone, and wherever the header itself is too
  // narrow for the full controls (a tablet with the sidebar open).
  const narrowHeader = useNarrowHeader();
  const compact = phone || narrowHeader;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const attention = attentionCount(session.preflight);

  useEditorHeaderTitle(session.displayName);
  useEditorHeaderRename(
    useCallback(() => document.getElementById("schedule-name")?.focus(), []),
  );

  const menu = [
    {
      actions:
        session.changed && !session.readOnly
          ? [
              {
                id: "discard",
                label: t("editor.header.discard"),
                icon: "restore",
                onSelect: session.discard,
              },
            ]
          : [],
    },
    {
      actions:
        session.schedule && canManage
          ? [
              {
                id: "delete",
                label: t("editor.header.delete"),
                icon: "delete",
                role: "destructive" as const,
                onSelect: () => setDeleteOpen(true),
              },
            ]
          : [],
    },
  ];
  const hasMenu = menu.some((group) => group.actions.length > 0);
  const reviewLabel =
    attention > 0
      ? t("editor.header.reviewIssues", { count: attention })
      : t("editor.header.review");

  return (
    <>
      <EditorHeaderPortal
        left={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("editor.header.back")}
                  onClick={() => void navigate("/schedules")}
                />
              }
            >
              <ArrowLeft aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>{t("editor.header.back")}</TooltipContent>
          </Tooltip>
        }
        right={
          <div className="flex shrink-0 items-center gap-2 max-[360px]:gap-1">
            {showReview && (
              <ReviewButton
                attention={attention}
                compact={compact}
                label={reviewLabel}
                onClick={onReview}
              />
            )}
            <SaveControls session={session} compact={compact} />
            {hasMenu && (
              <ActionMenuButton
                label={t("editor.header.more")}
                variant="ghost"
                size="icon-sm"
                actions={menu}
              />
            )}
          </div>
        }
      />
      <ScheduleDeleteDialog
        session={session}
        csrf={csrf}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </>
  );
}

function ReviewButton({
  attention,
  compact,
  label,
  onClick,
}: {
  attention: number;
  compact: boolean;
  label: string;
  onClick: () => void;
}) {
  const { t } = useTranslation("schedules");
  return (
    <Button
      type="button"
      variant="outline"
      size={compact ? "icon-sm" : "sm"}
      className="relative"
      aria-haspopup="dialog"
      aria-label={label}
      onClick={onClick}
    >
      <ListChecks aria-hidden="true" />
      {!compact && t("editor.header.review")}
      {attention > 0 &&
        (compact ? (
          // Beside the icon, not inside it: a phone has no room for
          // a second inline control.
          <Badge
            aria-hidden="true"
            className="absolute -end-1.5 -top-1.5 h-4 min-w-4 justify-center px-1 text-[10px]"
          >
            {attention}
          </Badge>
        ) : (
          <Badge variant="secondary">{attention}</Badge>
        ))}
    </Button>
  );
}

/** Save state and the Save button, or the view-only note. */
function SaveControls({
  session,
  compact,
}: {
  session: ScheduleEditorSession;
  compact: boolean;
}) {
  const { t } = useTranslation("schedules");
  const saveLabel = compact
    ? t("editor.header.saveShort")
    : session.isNew
      ? t("editor.header.create")
      : t("editor.header.save");
  return (
    <>
      {session.readOnly ? (
        <EditorSaveStatus
          state="readOnly"
          compact={compact}
          labels={{
            saved: t("editor.status.saved"),
            readOnly: t("editor.status.viewOnly"),
          }}
        />
      ) : (
        <>
          {compact && session.saveState !== "error" ? (
            // The Save button already shows clean, dirty, and saving, and
            // a phone has no room for a second indicator. Assistive
            // technology still hears the state.
            <span role="status" className="sr-only">
              {t(`editor.status.${session.saveState}`)}
            </span>
          ) : (
            <EditorSaveStatus
              state={session.saveState}
              compact={compact}
              onRetry={session.save}
              labels={{
                saved: t("editor.status.saved"),
                unsaved: t("editor.status.unsaved"),
                saving: t("editor.status.saving"),
                error: t("editor.status.failed"),
              }}
            />
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  className="max-[360px]:px-2"
                  disabled={!session.canSave}
                  aria-busy={session.saveState === "saving" || undefined}
                  aria-keyshortcuts="Control+S Meta+S"
                  onClick={session.save}
                />
              }
            >
              {session.saveState === "saving" && <Spinner aria-hidden="true" />}
              {session.saveState === "saving"
                ? t("editor.status.saving")
                : saveLabel}
            </TooltipTrigger>
            <TooltipContent>
              {saveLabel} <Kbd>{shortcutLabel()}</Kbd>
            </TooltipContent>
          </Tooltip>
        </>
      )}
    </>
  );
}
