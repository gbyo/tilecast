/**
 * The Schedule editor workspace: one continuous form that answers what plays,
 * when, and where, beside a pane that says what the draft will actually do.
 *
 * The form is deliberately not tabbed or stepped. Presentation, timing,
 * targets, and priority are parts of one rule, and an administrator checking
 * it needs to see them together. Where there is room the outcome stays beside
 * the form; where there is not, the header's Review opens the same content in
 * a Sheet (tablet) or a Drawer (phone). Only one of the three is ever mounted.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "../components/ui/drawer";
import { ScrollArea } from "../components/ui/scroll-area";
import { Separator } from "../components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import { useCompactLayout } from "../hooks/use-compact-layout";
import { useDesktopLayout } from "../hooks/use-desktop-layout";
import { scheduleFieldTargets } from "./scheduleEditorModel";
import { EDITOR_VIEWPORT_HEIGHT } from "./scheduleEditorParts";
import { ScheduleConflictSettings } from "./ScheduleConflictSettings";
import { ScheduleDetailsSection } from "./ScheduleDetailsSection";
import { ScheduleEditorHeader } from "./ScheduleEditorHeader";
import { ScheduleOutcomeContent } from "./ScheduleOutcome";
import { SchedulePresentationSection } from "./SchedulePresentationSection";
import { ScheduleTargetsSection } from "./ScheduleTargetsSection";
import { ScheduleTimingSection } from "./ScheduleTimingSection";
import type { ScheduleEditorSession } from "./useScheduleEditorSession";

/** Below this width the editor area cannot hold the form and a pane side by side. */
const PANE_MIN_WORKSPACE = 880;

/**
 * Whether the outcome has room beside the form. The viewport says only whether
 * the window is large; the open sidebar decides how much of it the editor has,
 * so the workspace measures itself. Unmeasured (tests) counts as wide.
 */
function useRoomForPane(desktop: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, room: desktop && (width === 0 || width >= PANE_MIN_WORKSPACE) };
}

export function ScheduleEditorWorkspace({
  session,
  csrf,
  canManage,
}: {
  session: ScheduleEditorSession;
  csrf: string;
  canManage: boolean;
}) {
  const { t } = useTranslation(["schedules", "common"]);
  const desktop = useDesktopLayout();
  const compact = useCompactLayout();
  const { ref, room } = useRoomForPane(desktop);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Folded sections open on their own only to show a problem: a date range
  // that is already set, or a priority that is not normal, starts open.
  const [dateRangeOpen, setDateRangeOpen] = useState(() =>
    Boolean(session.draft.startDate || session.draft.endDate),
  );
  const [conflictOpen, setConflictOpen] = useState(
    () => session.draft.priority !== 0,
  );

  // A failed save points at the first thing to fix: open what hides it, wait
  // for it to mount, then move focus there.
  const request = session.focusRequest;
  useEffect(() => {
    if (!request) return;
    if (request.field === "priority") setConflictOpen(true);
    if (request.field === "dateRange") setDateRangeOpen(true);
    const frame = requestAnimationFrame(() => {
      const target =
        document.getElementById(scheduleFieldTargets[request.field]) ??
        document.getElementById("schedule-display-action");
      target?.scrollIntoView?.({ block: "center" });
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [request]);

  const form = (
    <form
      aria-label={t("editor.formLabel")}
      noValidate
      // Saving is a deliberate act with its own control, never Enter in a field.
      onSubmit={(event) => event.preventDefault()}
      className="mx-auto grid w-full max-w-3xl gap-8 p-4 sm:p-6"
    >
      <ScheduleDetailsSection session={session} />
      <Separator />
      <SchedulePresentationSection session={session} />
      <Separator />
      <ScheduleTimingSection
        session={session}
        dateRangeOpen={dateRangeOpen}
        onDateRangeOpenChange={setDateRangeOpen}
      />
      <Separator />
      <ScheduleTargetsSection session={session} />
      <Separator />
      <ScheduleConflictSettings
        session={session}
        open={conflictOpen}
        onOpenChange={setConflictOpen}
      />
    </form>
  );

  return (
    <div
      ref={ref}
      className={`flex min-h-0 flex-col ${EDITOR_VIEWPORT_HEIGHT}`}
    >
      <h1 className="sr-only">
        {t("editor.heading", { name: session.displayName })}
      </h1>
      <ScheduleEditorHeader
        session={session}
        csrf={csrf}
        canManage={canManage}
        compact={compact}
        showReview={!room}
        onReview={() => setReviewOpen(true)}
      />
      {session.saveState === "error" && session.saveError && (
        <Alert
          variant="destructive"
          className="shrink-0 rounded-none border-x-0 border-t-0"
        >
          <AlertTitle>{t("editor.status.failed")}</AlertTitle>
          <AlertDescription>{session.saveError}</AlertDescription>
          <AlertAction>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={session.save}
            >
              {t("common:actions.retry")}
            </Button>
          </AlertAction>
        </Alert>
      )}
      <div className="flex min-h-0 flex-1">
        <ScrollArea className="h-full min-w-0 flex-1">{form}</ScrollArea>
        {room && (
          <aside
            aria-labelledby="schedule-outcome-heading"
            className="flex w-[22rem] shrink-0 flex-col border-s border-border max-xl:w-80"
          >
            <h2
              id="schedule-outcome-heading"
              className="shrink-0 px-4 pt-4 pb-2 text-base font-semibold"
            >
              {t("outcome.title")}
            </h2>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-4 pt-2 pb-6">
                <ScheduleOutcomeContent session={session} />
              </div>
            </ScrollArea>
          </aside>
        )}
      </div>
      {!room &&
        (compact ? (
          <Drawer
            open={reviewOpen}
            onOpenChange={setReviewOpen}
            showSwipeHandle
          >
            <DrawerContent className="max-h-[calc(100dvh-2rem)]">
              <DrawerHeader className="text-left">
                <DrawerTitle>{t("outcome.title")}</DrawerTitle>
                <DrawerDescription>
                  {t("outcome.description")}
                </DrawerDescription>
              </DrawerHeader>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-6">
                <ScheduleOutcomeContent session={session} />
              </div>
            </DrawerContent>
          </Drawer>
        ) : (
          <Sheet open={reviewOpen} onOpenChange={setReviewOpen}>
            <SheetContent side="right" className="w-full gap-0 sm:max-w-sm">
              <SheetHeader className="border-b border-border">
                <SheetTitle>{t("outcome.title")}</SheetTitle>
                <SheetDescription>{t("outcome.description")}</SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <ScheduleOutcomeContent session={session} />
              </div>
            </SheetContent>
          </Sheet>
        ))}
      {session.navigationDialog}
    </div>
  );
}
