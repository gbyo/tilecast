import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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

type Mode = ScreenGroup["displayMode"];

/**
 * Display mode is a choice first and a change second. Picking Span only
 * reveals the wall draft; nothing reaches the server until Save wall.
 */
export function DisplayGroupDisplay({
  group,
  manageable,
  csrfToken,
}: {
  group: ScreenGroup;
  manageable: boolean;
  csrfToken: string;
}) {
  const { t } = useTranslation(["screens", "layouts", "common"]);
  const client = useQueryClient();
  const [draftMode, setDraftMode] = useState<Mode>(group.displayMode);
  useEffect(() => setDraftMode(group.displayMode), [group.displayMode]);

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
          onValueChange={(next) => setDraftMode(next as Mode)}
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
    </div>
  );
}
