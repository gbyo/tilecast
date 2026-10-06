/**
 * The /schedules/new and /schedules/:id route. It does one job: get what the
 * editor needs, then hand a settled starting point to the session. The editor
 * never mounts on a half-loaded draft, so nothing it shows can be replaced
 * underneath the person using it.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import type { Schedule, ScheduleTarget } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import { scheduleQueries } from "../data/schedules";
import { screenQueries } from "../data/screens";
import { apiErrorMessage } from "../i18n";
import {
  draftFromSchedule,
  emptyDraft,
  type ScheduleDraft,
} from "./scheduleEditorModel";
import { EDITOR_VIEWPORT_HEIGHT } from "./scheduleEditorParts";
import { ScheduleEditorWorkspace } from "./ScheduleEditorWorkspace";
import {
  useScheduleEditorSession,
  type ScheduleCarriedDraft,
} from "./useScheduleEditorSession";

const canManageSchedules = (role?: string) =>
  role === "owner" || role === "administrator";

export function ScheduleEditorPage() {
  const { id } = useParams();
  return id ? <ExistingSchedule key={id} id={id} /> : <NewSchedule />;
}

function useEditorAuth() {
  const auth = useAuth();
  return {
    csrf: auth.status?.csrfToken ?? "",
    canManage: canManageSchedules(auth.status?.user?.role),
  };
}

/** A draft carried across the route change that follows a create, if it is for this schedule. */
function useCarriedDraft(): ScheduleDraft | undefined {
  const state: unknown = useLocation().state;
  const carried = (state as Partial<ScheduleCarriedDraft> | null)
    ?.scheduleDraft;
  return carried && typeof carried === "object" ? carried : undefined;
}

function ExistingSchedule({ id }: { id: string }) {
  const { t } = useTranslation("schedules");
  const { csrf, canManage } = useEditorAuth();
  const carried = useCarriedDraft();
  // The first answer is the editor's starting point. Later reads (a refetch
  // after a save, the entry removed after a delete) never reach the session.
  const [loaded, setLoaded] = useState<Schedule | null>(null);
  const query = useQuery({
    ...scheduleQueries.detail(id),
    enabled: loaded === null,
  });
  if (query.data && !loaded) setLoaded(query.data);
  const schedule = loaded ?? query.data;
  if (schedule)
    return (
      <SessionHost
        schedule={schedule}
        initial={carried ?? draftFromSchedule(schedule)}
        carried={Boolean(carried)}
        csrf={csrf}
        canManage={canManage}
      />
    );
  if (query.isError) {
    const missing =
      query.error instanceof ApiError &&
      (query.error.status === 404 || query.error.code === "schedule_not_found");
    return missing ? (
      <EditorEmpty
        title={t("editor.notFound.title")}
        body={t("editor.notFound.body")}
      />
    ) : (
      <EditorLoadFailed
        error={query.error}
        retry={() => void query.refetch()}
      />
    );
  }
  return <EditorSkeleton />;
}

/**
 * The one screen or Display Group a new schedule was opened from. A grouped
 * screen schedules through its group, as the server normalizes it. A lookup
 * that failed (the screen is gone, or out of scope) just means there is
 * nothing to preselect.
 */
function usePrefillTarget(screenId: string, groupId: string) {
  const screen = useQuery({
    ...screenQueries.detail(screenId),
    enabled: Boolean(screenId),
    retry: false,
  });
  const group = useQuery({
    queryKey: ["screen-groups", groupId],
    queryFn: () => api.screenGroup(groupId),
    enabled: Boolean(groupId) && !screenId,
    retry: false,
  });
  const pending =
    (Boolean(screenId) && screen.isPending) ||
    (Boolean(groupId) && !screenId && group.isPending);
  let target: ScheduleTarget | null = null;
  if (screenId && screen.data)
    target = screen.data.syncGroupId
      ? {
          type: "group",
          id: screen.data.syncGroupId,
          name: screen.data.syncGroupName,
        }
      : { type: "screen", id: screen.data.id, name: screen.data.name };
  else if (!screenId && groupId && group.data)
    target = { type: "group", id: group.data.id, name: group.data.name };
  return { pending, target };
}

/**
 * A new schedule starts from the organization's timezone and, when opened
 * from a screen or Display Group, that one target. Both are settled before
 * the editor mounts, so applying them is never an edit and a later answer can
 * never overwrite what the author chose.
 */
function NewSchedule() {
  const { t } = useTranslation("schedules");
  const { csrf, canManage } = useEditorAuth();
  const [params] = useSearchParams();
  const prefill = usePrefillTarget(
    params.get("screen") ?? "",
    params.get("group") ?? "",
  );
  const defaults = useQuery(scheduleQueries.defaults());
  const [initial, setInitial] = useState<ScheduleDraft | null>(null);
  if (!canManage)
    return (
      <EditorEmpty
        title={t("editor.cannotCreate.title")}
        body={t("editor.cannotCreate.body")}
      />
    );
  if (defaults.isError)
    return (
      <EditorLoadFailed
        error={defaults.error}
        retry={() => void defaults.refetch()}
      />
    );
  const timezone = defaults.data?.defaultTimezone;
  if (initial === null && timezone && !prefill.pending) {
    setInitial({
      ...emptyDraft(timezone),
      targets: prefill.target ? [prefill.target] : [],
    });
  }
  if (!initial) return <EditorSkeleton />;
  return <SessionHost initial={initial} csrf={csrf} canManage={canManage} />;
}

function SessionHost({
  schedule,
  initial,
  carried = false,
  csrf,
  canManage,
}: {
  schedule?: Schedule;
  initial: ScheduleDraft;
  /** The initial draft came from the route state of a create. */
  carried?: boolean;
  csrf: string;
  canManage: boolean;
}) {
  const session = useScheduleEditorSession({
    schedule,
    initial,
    carried,
    csrf,
    readOnly: !canManage,
  });
  return (
    <ScheduleEditorWorkspace
      session={session}
      csrf={csrf}
      canManage={canManage}
    />
  );
}

/** An empty state with the way back to the list. */
function EditorEmpty({ title, body }: { title: string; body: string }) {
  const { t } = useTranslation("schedules");
  return (
    <EditorMessage>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{body}</EmptyDescription>
        </EmptyHeader>
        <Link
          to="/schedules"
          className={buttonVariants({ variant: "outline" })}
        >
          {t("editor.notFound.back")}
        </Link>
      </Empty>
    </EditorMessage>
  );
}

/** A read that failed, with its reason and a retry. */
function EditorLoadFailed({
  error,
  retry,
}: {
  error: Error | null;
  retry: () => void;
}) {
  const { t } = useTranslation("schedules");
  return (
    <EditorMessage>
      <Alert variant="destructive">
        <AlertTitle>{t("editor.loadFailed.title")}</AlertTitle>
        <AlertDescription className="grid gap-2">
          <span>{apiErrorMessage(error)}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={retry}
          >
            {t("editor.loadFailed.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    </EditorMessage>
  );
}

function EditorMessage({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-xl p-6">{children}</div>;
}

/** The editor's own shape while it loads: header, fields, and the outcome pane. */
function EditorSkeleton() {
  const { t } = useTranslation("schedules");
  return (
    <div
      className={`flex min-h-0 flex-col ${EDITOR_VIEWPORT_HEIGHT}`}
      role="status"
      aria-label={t("editor.loading")}
    >
      <h1 className="sr-only">{t("editor.loading")}</h1>
      <div className="flex min-h-0 flex-1">
        <div className="mx-auto grid w-full max-w-3xl content-start gap-6 p-4 sm:p-6">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-9 w-1/2" />
        </div>
        <div className="hidden w-[22rem] shrink-0 content-start gap-4 border-s border-border p-4 xl:grid">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
    </div>
  );
}
