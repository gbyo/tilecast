import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { ScreenGroup } from "../../api/types";
import { DisplayControlGroupActions } from "../../components/DisplayControlGroupActions";
import { SpanWallEditor } from "../../components/SpanWallEditor";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "../../components/ui/field";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { Separator } from "../../components/ui/separator";
import { DiscardChangesDialog } from "./DiscardChangesDialog";

type Mode = ScreenGroup["displayMode"];

/**
 * Display mode is a choice first and a change second. Picking Span only
 * reveals the wall draft; nothing reaches the server until Save wall.
 */
export function DisplayGroupDisplay({
  group,
  manageable,
  csrfToken,
  onDirtyChange,
}: {
  group: ScreenGroup;
  manageable: boolean;
  csrfToken: string;
  /** Whether the wall has unsaved changes, for the page's navigation guard. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation(["screens", "layouts", "common"]);
  const client = useQueryClient();
  const [draftMode, setDraftMode] = useState<Mode>(group.displayMode);
  useEffect(() => setDraftMode(group.displayMode), [group.displayMode]);
  // Read only when the mode changes, so it never needs to re-render.
  const wallDirty = useRef(false);
  const [confirmMirror, setConfirmMirror] = useState(false);
  const reportWallDirty = useCallback(
    (dirty: boolean) => {
      wallDirty.current = dirty;
      onDirtyChange?.(dirty);
    },
    [onDirtyChange],
  );
  const chooseMode = (next: Mode) => {
    // Leaving Span would drop the wall draft, so ask before it is lost.
    if (next === "mirror" && wallDirty.current) setConfirmMirror(true);
    else setDraftMode(next);
  };

  const returnToMirror = useMutation({
    mutationFn: () =>
      api.updateSpanGeometry(group.id, { displayMode: "mirror" }, csrfToken),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["screen-groups"] });
    },
  });

  const noScreens = group.screens.length === 0;
  const leavingSpan = group.displayMode === "span" && draftMode === "mirror";

  return (
    <div className="grid max-w-3xl gap-6">
      <section className="grid gap-4">
        <header className="grid gap-1">
          <h2 className="text-base font-semibold">
            {t("groups.display.modeTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("groups.display.modeDescription")}
          </p>
        </header>
        <RadioGroup
          aria-label={t("groups.display.modeTitle")}
          value={draftMode}
          disabled={!manageable}
          onValueChange={(next) => chooseMode(next as Mode)}
        >
          <FieldLabel htmlFor="display-mode-mirror">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>{t("groups.detail.modeMirror")}</FieldTitle>
                <FieldDescription>
                  {t("groups.display.mirrorDescription")}
                </FieldDescription>
              </FieldContent>
              <RadioGroupItem value="mirror" id="display-mode-mirror" />
            </Field>
          </FieldLabel>
          <FieldLabel htmlFor="display-mode-span">
            <Field orientation="horizontal" data-disabled={noScreens}>
              <FieldContent>
                <FieldTitle>{t("groups.detail.modeSpan")}</FieldTitle>
                <FieldDescription>
                  {noScreens
                    ? t("groups.display.spanNeedsScreens")
                    : t("groups.display.spanDescription")}
                </FieldDescription>
              </FieldContent>
              <RadioGroupItem
                value="span"
                id="display-mode-span"
                disabled={noScreens}
              />
            </Field>
          </FieldLabel>
        </RadioGroup>

        {leavingSpan && manageable && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3">
            <p className="text-sm font-medium" role="status">
              {t("groups.display.leavingSpan")}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={returnToMirror.isPending}
                onClick={() => setDraftMode("span")}
              >
                {t("layouts:spanWall.discardAction")}
              </Button>
              <Button
                type="button"
                disabled={returnToMirror.isPending}
                onClick={() => returnToMirror.mutate()}
              >
                {returnToMirror.isPending
                  ? t("common:actions.saving")
                  : t("groups.display.saveMode")}
              </Button>
            </div>
          </div>
        )}
        {returnToMirror.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {t("groups.display.saveModeFailed")}
            </AlertDescription>
          </Alert>
        )}
      </section>

      {draftMode === "span" && !noScreens && (
        <>
          <Separator />
          <SpanWallEditor
            group={group}
            manageable={manageable}
            csrfToken={csrfToken}
            onDiscardNewWall={() => setDraftMode("mirror")}
            onDirtyChange={reportWallDirty}
          />
        </>
      )}

      {manageable && group.screens.length > 0 && (
        <>
          <Separator />
          <DisplayControlGroupActions
            groupId={group.id}
            memberCount={group.membershipCount}
            manageable={manageable}
            csrfToken={csrfToken}
          />
        </>
      )}
      <DiscardChangesDialog
        open={confirmMirror}
        title={t("groups.detail.discardWallTitle")}
        description={t("groups.detail.discardWallBody")}
        onKeepEditing={() => setConfirmMirror(false)}
        onDiscard={() => {
          setConfirmMirror(false);
          setDraftMode("mirror");
        }}
      />
    </div>
  );
}
