import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { ScreenGroup } from "../api/types";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { SpanCanvasControls } from "./span-wall/SpanCanvasControls";
import { SpanPanelAccordion } from "./span-wall/SpanPanelAccordion";
import { SpanPreparationStatus } from "./span-wall/SpanPreparationStatus";
import { SpanPreview } from "./span-wall/SpanPreview";
import { useSpanWallDraft } from "./span-wall/useSpanWallDraft";

type Props = {
  group: ScreenGroup;
  manageable: boolean;
  csrfToken: string;
  /**
   * The group is still Mirror and this wall has never been saved. Discarding
   * then means going back to Mirror, which the caller owns.
   */
  onDiscardNewWall?: () => void;
  /**
   * Reports whether the wall has changes that are not saved: edits, presets,
   * or a draft wall that has never been saved. False after a save, a
   * discard, or when the editor goes away.
   */
  onDirtyChange?: (dirty: boolean) => void;
};

export function SpanWallEditor({
  group,
  manageable,
  csrfToken,
  onDiscardNewWall,
  onDirtyChange,
}: Props) {
  const { t } = useTranslation(["layouts", "common"]);
  const client = useQueryClient();
  const saved = group.displayMode === "span";
  const status = useQuery({
    queryKey: ["screen-groups", group.id, "span"],
    queryFn: () => api.spanStatus(group.id),
    enabled: saved,
    refetchInterval: 10_000,
  });
  const draft = useSpanWallDraft(group, status.data);
  const { canvas, panels, dirty } = draft;

  // The parent guards navigation with this, and must also hear "clean" when
  // the editor goes away, so it is reported from effects like the Player
  // policy editor does rather than from each handler.
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = useMutation({
    mutationFn: () =>
      api.updateSpanGeometry(
        group.id,
        { displayMode: "span", canvas, panels },
        csrfToken,
      ),
    onSuccess: () => {
      draft.markSaved();
      void client.invalidateQueries({ queryKey: ["screen-groups", group.id] });
      void client.invalidateQueries({ queryKey: ["screen-groups"] });
    },
  });

  const screenNames = useMemo(
    () => new Map(group.screens.map((screen) => [screen.id, screen.name])),
    [group.screens],
  );

  const discard = () => {
    if (!saved) {
      onDiscardNewWall?.();
      return;
    }
    draft.reset();
    save.reset();
  };

  return (
    <section className="grid gap-5">
      <SpanCanvasControls
        canvas={canvas}
        manageable={manageable}
        onSizeChange={draft.setCanvasSize}
        onPreset={draft.applyPreset}
      />
      <SpanPreview canvas={canvas} panels={panels} screenNames={screenNames} />
      <SpanPanelAccordion
        panels={panels}
        screenNames={screenNames}
        manageable={manageable}
        onChange={draft.setPanel}
      />

      {save.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("spanWall.saveFailed")}</AlertDescription>
        </Alert>
      )}
      {status.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("spanWall.statusFailed")}</AlertDescription>
        </Alert>
      )}

      {manageable && (dirty || save.isPending) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3">
          <p className="text-sm font-medium" role="status">
            {saved ? t("spanWall.unsavedChanges") : t("spanWall.unsavedWall")}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={discard}
            >
              {t("spanWall.discardAction")}
            </Button>
            <Button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("common:actions.saving")
                : t("spanWall.saveAction")}
            </Button>
          </div>
        </div>
      )}

      {saved && panels.length > 0 && (
        <SpanPreparationStatus
          panels={panels}
          preparations={status.data?.preparations ?? []}
          screenNames={screenNames}
        />
      )}
    </section>
  );
}
