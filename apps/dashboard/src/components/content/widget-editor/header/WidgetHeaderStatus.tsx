import { Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EditorSaveStatus } from "@/components/studio/EditorSaveStatus";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WidgetEditorSession } from "../useWidgetEditorSession";
import { shortcutLabel } from "./headerModel";

/** How many playlists and Layouts a save would change, as a button that lists them. */
export function WidgetUsageButton({
  label,
  onOpen,
}: {
  label: string;
  onOpen: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-haspopup="dialog"
      onClick={onOpen}
    >
      <Users aria-hidden="true" />
      {label}
    </Button>
  );
}

/** The save state and the Save button, or the view-only note. */
export function WidgetHeaderStatus({
  session,
  compact,
}: {
  session: WidgetEditorSession;
  compact: boolean;
}) {
  const { t } = useTranslation("content");
  if (session.readOnly)
    return (
      <EditorSaveStatus
        state="readOnly"
        compact={compact}
        labels={{
          saved: t("widgets.editor.status.saved"),
          readOnly: t("widgets.editor.status.viewOnly"),
        }}
      />
    );
  const saveLabel = compact
    ? t("widgets.editor.saveShort")
    : session.isNew
      ? t("widgets.editor.saveNew")
      : t("widgets.editor.save");
  return (
    <>
      <EditorSaveStatus
        state={session.saveState}
        compact={compact}
        onRetry={session.save}
        labels={{
          saved: t("widgets.editor.status.saved"),
          unsaved: session.isNew
            ? t("widgets.editor.status.notSaved")
            : t("widgets.editor.status.unsaved"),
          saving: t("widgets.editor.status.saving"),
          error: t("widgets.editor.status.failed"),
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="sm"
              disabled={!session.canSave}
              aria-busy={session.saveState === "saving" || undefined}
              aria-keyshortcuts="Control+S Meta+S"
              onClick={session.save}
            />
          }
        >
          {session.saveState === "saving" && <Spinner aria-hidden="true" />}
          {saveLabel}
        </TooltipTrigger>
        <TooltipContent>
          {saveLabel} <Kbd>{shortcutLabel()}</Kbd>
        </TooltipContent>
      </Tooltip>
    </>
  );
}
