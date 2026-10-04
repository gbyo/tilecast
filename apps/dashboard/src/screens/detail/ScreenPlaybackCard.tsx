import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { CircleAlert, Ellipsis } from "lucide-react";
import { api } from "../../api/client";
import type { PlaylistAssignment } from "../../api/types";
import type { PlaylistPickerChoice } from "../../components/content-picker/PlaylistPicker";
import { PlaylistPicker } from "../../components/content-picker/PlaylistPicker";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../../components/ui/item";
import { Separator } from "../../components/ui/separator";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { toast } from "../../components/ui/toast";
import { screenKeys } from "../../data/screens";
import { apiErrorMessage, useFormatLocale } from "../../i18n";
import {
  defaultContent,
  expectedNow,
  playbackFaults,
  type PlaybackPlan,
} from "./screenPlaybackModel";

const humanize = (value: string) => value.replaceAll("_", " ");

function formatWindow(
  window: { start?: string; end?: string } | undefined,
  locale: string,
): string | null {
  if (!window?.start || !window?.end) return null;
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  const start = new Date(window.start).toLocaleTimeString(locale, options);
  const end = new Date(window.end).toLocaleTimeString(locale, options);
  return `${start}–${end}`;
}

function ExpectedNowSection({
  screenId,
  plan,
  planLoading,
  planError,
  assignment,
  screenStatus,
  lastContactAt,
  onExplain,
}: {
  screenId: string;
  plan?: PlaybackPlan;
  planLoading: boolean;
  planError: unknown;
  assignment?: PlaylistAssignment;
  screenStatus: string;
  lastContactAt?: string;
  onExplain: () => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const locale = useFormatLocale();
  const expected = expectedNow(plan);

  if (planLoading && !plan) {
    return (
      <div
        role="status"
        aria-label={t("playback.loadingExpected")}
        className="space-y-2"
      >
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (planError && !plan) {
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>{t("playback.expectedLoadError")}</AlertTitle>
        <AlertDescription>{apiErrorMessage(planError)}</AlertDescription>
      </Alert>
    );
  }

  const syncLabel = assignment?.synchronizationStatus
    ? t(
        `playbackPlan.synchronizationStatus.${assignment.synchronizationStatus}`,
      )
    : null;
  const playbackPart =
    assignment?.playbackState?.trim() ||
    (screenStatus === "online"
      ? t("shared.notReported")
      : t(`status.${screenStatus}`, {
          defaultValue: humanize(screenStatus),
        }));
  const playerLine =
    lastContactAt && screenStatus !== "online" && !assignment?.playbackState
      ? t("playback.playerOffline", {
          status: playbackPart,
          at: new Date(lastContactAt).toLocaleString(locale),
        })
      : syncLabel
        ? t("playback.player", { state: playbackPart, sync: syncLabel })
        : t("playback.playerBare", { state: playbackPart });

  const context = (() => {
    if (!expected) return t("playback.noExpectedContent");
    switch (expected.source) {
      case "schedule": {
        const window = formatWindow(expected.window, locale);
        return window
          ? t("playback.expectedScheduledWindow", {
              name: expected.scheduleName,
              window,
            })
          : t("playback.expectedScheduled", {
              name: expected.scheduleName,
            });
      }
      case "takeover":
        return t("playback.takeoverOverrides");
      case "quick_present":
        return t("playback.showNowOverrides");
      default:
        return t("playback.noOverride");
    }
  })();

  return (
    <section aria-labelledby={`${screenId}-expected`} className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${screenId}-expected`} className="text-sm font-semibold">
          {t("playback.expectedNow")}
        </h3>
        <Button variant="ghost" size="sm" onClick={onExplain}>
          {t("playback.whyThis")}
        </Button>
      </div>
      <ItemGroup className="mt-1">
        <Item size="sm" className="px-0">
          <ItemContent>
            <ItemTitle className="flex flex-wrap items-center gap-2 text-base">
              <span className="min-w-0 break-words">
                {expected?.name ?? t("playback.missingContent")}
              </span>
              {expected && (
                <Badge variant="secondary">
                  {t(`playback.sources.${expected.source}`)}
                </Badge>
              )}
            </ItemTitle>
            <ItemDescription>{context}</ItemDescription>
            <ItemDescription>
              <span className="text-muted-foreground">{playerLine}</span>
            </ItemDescription>
          </ItemContent>
        </Item>
      </ItemGroup>
    </section>
  );
}

type PendingChange =
  { kind: "assign"; choice: PlaylistPickerChoice } | { kind: "remove" };

function DefaultContentSection({
  screenId,
  screenName,
  assignment,
  assignmentLoading,
  canManage,
  csrfToken,
}: {
  screenId: string;
  screenName: string;
  assignment?: PlaylistAssignment;
  assignmentLoading: boolean;
  canManage: boolean;
  csrfToken: string;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const content = defaultContent(assignment);
  const group = content.state === "assigned" ? content.group : undefined;
  const groupDetail = useQuery({
    queryKey: ["screen-groups", group?.id ?? ""],
    queryFn: () => api.screenGroup(group?.id ?? ""),
    enabled: Boolean(group?.id),
  });
  const memberCount = groupDetail.data?.membershipCount;

  const commit = useMutation({
    mutationFn: (change: PendingChange) => {
      if (change.kind === "remove") {
        return api.unassignPlaylist(screenId, csrfToken);
      }
      return change.choice.kind === "layout"
        ? api.assignLayout(screenId, change.choice.layout.id, csrfToken)
        : api.assignPlaylist(screenId, change.choice.playlist.id, csrfToken);
    },
    onSuccess: async () => {
      toast.add({
        title: t("playback.assignmentUpdated"),
        type: "success",
      });
      setPending(null);
      setPickerOpen(false);
      await queryClient.invalidateQueries({
        queryKey: screenKeys.assignment(screenId),
      });
      // Expected now, Default, and Next stay coherent: the prefix covers both
      // the polling current-state key and any specified-instant keys.
      await queryClient.invalidateQueries({
        queryKey: [...screenKeys.detail(screenId), "playback-plan"],
      });
    },
  });

  const requestChange = (change: PendingChange) => {
    // Standalone screens commit immediately; a group-managed assignment needs
    // an explicit scope confirmation because it updates every member screen.
    if (!group) {
      commit.mutate(change);
      return;
    }
    setPending(change);
  };

  const confirmOpen = pending !== null && group != null;

  if (assignmentLoading && !assignment) {
    return (
      <div
        role="status"
        aria-label={t("playback.loadingDefault")}
        className="space-y-2"
      >
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  return (
    <section aria-labelledby={`${screenId}-default`} className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${screenId}-default`} className="text-sm font-semibold">
          {t("playback.defaultTitle")}
        </h3>
        {group && <Badge variant="outline">{t("playback.groupManaged")}</Badge>}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("playback.defaultBody")}
      </p>

      {content.state === "none" ? (
        <Empty className="mt-3 gap-2 border border-dashed py-6">
          <EmptyHeader>
            <EmptyTitle className="text-sm">
              {t("playback.noDefaultTitle")}
            </EmptyTitle>
            <EmptyDescription>{t("playback.noDefaultBody")}</EmptyDescription>
          </EmptyHeader>
          {canManage && (
            <EmptyContent>
              <Button size="sm" onClick={() => setPickerOpen(true)}>
                {t("playback.chooseDefault")}
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <ItemGroup className="mt-1">
          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-base">
                {content.name ?? t("playback.missingContent")}
              </ItemTitle>
              <ItemDescription>
                {t(`playbackPlan.types.${content.kind}`)}
                {content.revision != null &&
                  ` · ${t("playback.revision", { revision: content.revision })}`}
              </ItemDescription>
              {group && (
                <ItemDescription>
                  <Link
                    to={`/groups/${group.id}`}
                    className="underline underline-offset-4"
                  >
                    {group.name}
                  </Link>
                </ItemDescription>
              )}
            </ItemContent>
            {canManage && (
              <ItemActions className="flex-row items-center">
                <Button size="sm" onClick={() => setPickerOpen(true)}>
                  {group
                    ? t("playback.changeForGroup", { name: group.name })
                    : t("playback.changeDefault")}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon-sm" />}
                    aria-label={t("playback.moreDefaultActions")}
                  >
                    <Ellipsis aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => requestChange({ kind: "remove" })}
                    >
                      {t("playback.removeDefault")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </ItemActions>
            )}
          </Item>
        </ItemGroup>
      )}

      <PlaylistPicker
        open={pickerOpen}
        title={t("playback.pickerTitle")}
        description={t("playback.pickerDescription")}
        confirmLabel={
          commit.isPending
            ? t("common:status.loading")
            : t("playback.pickerConfirm")
        }
        includeLayouts
        selectedId={content.state === "assigned" ? content.id : undefined}
        onConfirm={(choice) => requestChange({ kind: "assign", choice })}
        onClose={() => {
          if (!commit.isPending) setPickerOpen(false);
        }}
      />

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && !commit.isPending) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === "remove"
                ? t("playback.removeGroupTitle", { name: group?.name })
                : t("playback.changeGroupTitle", { name: group?.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {typeof memberCount === "number"
                ? t("playback.changeGroupBody", {
                    count: memberCount,
                    screen: screenName,
                  })
                : t("playback.changeGroupBodyUnknown", {
                    screen: screenName,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={commit.isPending}>
              {t("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant={pending?.kind === "remove" ? "destructive" : "default"}
              disabled={commit.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (pending) commit.mutate(pending);
              }}
            >
              {commit.isPending && <Spinner aria-hidden="true" />}
              {pending?.kind === "remove"
                ? typeof memberCount === "number"
                  ? t("playback.removeGroupConfirm", { count: memberCount })
                  : t("playback.removeDefault")
                : typeof memberCount === "number"
                  ? t("playback.changeGroupConfirm", { count: memberCount })
                  : t("playback.changeDefault")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {commit.isError && (
        <Alert variant="destructive" className="mt-3">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{t("playback.assignError")}</AlertTitle>
          <AlertDescription>{apiErrorMessage(commit.error)}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function PlaybackFaults({
  assignment,
  onOpenDiagnostics,
}: {
  assignment?: PlaylistAssignment;
  onOpenDiagnostics: () => void;
}) {
  const { t } = useTranslation("screens");
  const faults = playbackFaults(assignment);
  if (faults.length === 0) return null;
  return (
    <div className="space-y-2">
      {faults.map((fault) => {
        if (fault.kind === "clock") {
          return (
            <Alert key={fault.kind}>
              <CircleAlert aria-hidden="true" />
              <AlertTitle>{t("detail.clockTitle")}</AlertTitle>
              <AlertDescription>
                {t("detail.clockBody")}{" "}
                <Button variant="link" size="sm" onClick={onOpenDiagnostics}>
                  {t("playback.viewDiagnostics")}
                </Button>
              </AlertDescription>
            </Alert>
          );
        }
        if (fault.kind === "schedule") {
          return (
            <Alert key={fault.kind} variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>{t("detail.scheduleEvalTitle")}</AlertTitle>
              <AlertDescription>{fault.message}</AlertDescription>
            </Alert>
          );
        }
        if (fault.kind === "website") {
          return (
            <Alert key={fault.kind} variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>{t("detail.websiteTitle")}</AlertTitle>
              <AlertDescription>
                {fault.message?.replaceAll("_", " ") ??
                  t("detail.websiteUnknown")}
              </AlertDescription>
            </Alert>
          );
        }
        const errorKind =
          fault.kind === "synchronization"
            ? "sync"
            : fault.kind === "playback"
              ? "playback"
              : "config";
        return (
          <Alert key={fault.kind} variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>
              {t("detail.categorizedError", {
                kind: t(`detail.errorKind.${errorKind}`),
              })}
            </AlertTitle>
            <AlertDescription>{fault.message}</AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}

export function ScreenPlaybackCard({
  screenId,
  screenName,
  screenStatus,
  lastContactAt,
  assignment,
  assignmentLoading,
  assignmentError,
  plan,
  planLoading,
  planError,
  canManage,
  csrfToken,
  onExplain,
  onOpenDiagnostics,
}: {
  screenId: string;
  screenName: string;
  screenStatus: string;
  lastContactAt?: string;
  assignment?: PlaylistAssignment;
  assignmentLoading: boolean;
  assignmentError: unknown;
  plan?: PlaybackPlan;
  planLoading: boolean;
  planError: unknown;
  canManage: boolean;
  csrfToken: string;
  onExplain: () => void;
  onOpenDiagnostics: () => void;
}) {
  const { t } = useTranslation("screens");
  return (
    <Card id="screen-content" className="min-w-0 scroll-mt-20">
      <CardHeader>
        <CardTitle>{t("playback.title")}</CardTitle>
        <CardDescription>{t("playback.body")}</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={onOpenDiagnostics}>
            {t("detail.diagnostics")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="min-w-0 space-y-5">
        <ExpectedNowSection
          screenId={screenId}
          plan={plan}
          planLoading={planLoading}
          planError={planError}
          assignment={assignment}
          screenStatus={screenStatus}
          lastContactAt={lastContactAt}
          onExplain={onExplain}
        />
        <Separator />
        <DefaultContentSection
          screenId={screenId}
          screenName={screenName}
          assignment={assignment}
          assignmentLoading={assignmentLoading}
          canManage={canManage}
          csrfToken={csrfToken}
        />
        {assignmentError != null && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{t("detail.assignLoadError")}</AlertTitle>
            <AlertDescription>
              {apiErrorMessage(assignmentError)}
            </AlertDescription>
          </Alert>
        )}
        <PlaybackFaults
          assignment={assignment}
          onOpenDiagnostics={onOpenDiagnostics}
        />
      </CardContent>
    </Card>
  );
}
