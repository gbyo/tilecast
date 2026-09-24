import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { LayoutGrid } from "lucide-react";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { useConfirm } from "../components/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import type { ScreenGroup } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useFormatLocale } from "../i18n";

type ScreensT = TFunction<"screens", undefined>;
import { PlayerPolicyEditor } from "../settings/PlayerPolicyEditor";
import { AirPlayPresentDialog } from "../components/AirPlayPresentDialog";
import { QuickPresentDialog } from "../components/QuickPresentDialog";
import { SpanWallEditor } from "../components/SpanWallEditor";
import { DisplayControlGroupActions } from "../components/DisplayControlGroupActions";
import { toast } from "../components/ui/toast";

const canManage = (role?: string) =>
  role === "owner" || role === "administrator";

function groupFallbackName(
  group: Pick<ScreenGroup, "layoutName" | "playlistName">,
  t: ScreensT,
) {
  return group.layoutName ?? group.playlistName ?? t("groups.noFallback");
}

function groupFallbackType(
  group: Pick<ScreenGroup, "layoutName" | "playlistName">,
  t: ScreensT,
) {
  if (group.layoutName) return t("groups.fallbackType.layout");
  if (group.playlistName) return t("groups.fallbackType.playlist");
  return t("groups.fallbackType.none");
}

function groupMemberSummary(group: ScreenGroup, t: ScreensT) {
  const screens = group.screens ?? [];
  if (group.membershipCount === 0) return t("groups.memberSummary.none");
  if (screens.length === 0)
    return t("groups.memberSummary.assigned", {
      count: group.membershipCount,
    });
  const visible = screens.slice(0, 3).map((screen) => screen.name);
  const remaining = Math.max(0, group.membershipCount - visible.length);
  if (!remaining) return visible.join(", ");
  return t("groups.memberSummary.overflow", {
    names: visible.join(", "),
    count: remaining,
  });
}

function formatGroupDate(value: string, t: ScreensT, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("groups.unknownDate");
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function GroupsPage() {
  const auth = useAuth(),
    csrf = auth.status?.csrfToken ?? "",
    client = useQueryClient();
  const { t } = useTranslation("screens");
  const formatLocale = useFormatLocale();
  const manageable = canManage(auth.status?.user?.role);
  const q = useQuery({
    queryKey: ["screen-groups"],
    queryFn: () => api.screenGroups(),
  });
  const [createOpen, setCreateOpen] = useState(false);
  const create = useMutation({
    mutationFn: (value: { name: string; description: string }) =>
      api.createScreenGroup(value, csrf),
    onSuccess: () => {
      toast.add({ title: "Display Group created.", type: "success" });
      return client.invalidateQueries({ queryKey: ["screen-groups"] });
    },
  });

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("groups.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("groups.subtitle")}
          </p>
        </div>
        {manageable && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => setCreateOpen(true)}>
              {t("groups.create")}
            </Button>
          </div>
        )}
      </header>
      {q.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("groups.loadError")}</AlertDescription>
        </Alert>
      )}
      {q.isLoading && (
        <div className="grid gap-2" aria-label={t("groups.loading")}>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {q.data?.items?.map((group) => (
          <Link
            className="grid gap-3 rounded-xl border border-border p-4 hover:bg-muted"
            to={`/groups/${group.id}`}
            key={group.id}
          >
            <span className="flex items-start justify-between gap-2">
              <span className="grid min-w-0 gap-0.5">
                <strong className="truncate text-sm">{group.name}</strong>
                <small className="truncate text-xs text-muted-foreground">
                  {group.description || t("groups.noDescription")}
                </small>
              </span>
              <Badge
                variant={group.membershipCount > 0 ? "default" : "secondary"}
              >
                {t("groups.count", { count: group.membershipCount })}
              </Badge>
            </span>
            <dl className="grid gap-2 text-sm">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">
                  {t("groups.fallbackLabel")}
                </dt>
                <dd className="flex flex-wrap gap-x-2">
                  <span>{groupFallbackType(group, t)}</span>
                  <strong>{groupFallbackName(group, t)}</strong>
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">
                  {t("groups.updatedLabel")}
                </dt>
                <dd>{formatGroupDate(group.updatedAt, t, formatLocale)}</dd>
              </div>
            </dl>
            <span className="text-sm text-muted-foreground">
              {groupMemberSummary(group, t)}
            </span>
            <span className="text-sm font-medium">{t("groups.viewGroup")}</span>
          </Link>
        ))}
      </div>
      {q.data?.items?.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutGrid size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("groups.emptyTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("groups.emptyDescription")}
              {manageable && (
                <Button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="mt-3"
                >
                  {t("groups.create")}
                </Button>
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {createOpen && (
        <GroupDialog
          title={t("groups.create")}
          action={t("groups.detail.dialogCreateAction")}
          initial={{ name: "", description: "" }}
          pending={create.isPending}
          onClose={() => setCreateOpen(false)}
          onSave={(value) => {
            create.mutate(value);
            setCreateOpen(false);
          }}
        />
      )}
    </section>
  );
}

export function GroupDetailPage() {
  const { id = "" } = useParams(),
    navigate = useNavigate(),
    auth = useAuth(),
    csrf = auth.status?.csrfToken ?? "",
    client = useQueryClient();
  const { t } = useTranslation(["screens", "common"]);
  const formatLocale = useFormatLocale();
  const manageable = canManage(auth.status?.user?.role);
  const [screenSearch, setScreenSearch] = useState("");
  const [selectedPresentation, setSelectedPresentation] = useState("");
  const [airplayOpen, setAirplayOpen] = useState(false);
  const [quickPresentOpen, setQuickPresentOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const group = useQuery({
      queryKey: ["screen-groups", id],
      queryFn: () => api.screenGroup(id),
    }),
    screens = useQuery({ queryKey: ["screens"], queryFn: api.screens }),
    groups = useQuery({
      queryKey: ["screen-groups"],
      queryFn: () => api.screenGroups(),
    }),
    playlists = useQuery({
      queryKey: ["playlists", "sync-group"],
      queryFn: () => api.playlists(),
    }),
    layouts = useQuery({
      queryKey: ["layouts", "sync-group"],
      queryFn: () => api.layouts(""),
    });
  const groupAirplayQueries = useQueries({
    queries: (group.data?.screens ?? []).map((screen) => ({
      queryKey: ["screen-reliability", screen.id],
      queryFn: () => api.screenReliability(screen.id),
      refetchInterval: 10_000,
    })),
  });
  const groupAirplayCapabilities = groupAirplayQueries.flatMap((query) =>
    query.data ? [query.data] : [],
  );
  const groupAirplayLoading = groupAirplayQueries.some(
    (query) => query.isPending,
  );
  const groupAirplayError = groupAirplayQueries.find((query) => query.error)
    ?.error?.message;
  const refresh = () =>
    client.invalidateQueries({ queryKey: ["screen-groups", id] });
  const add = useMutation({
      mutationFn: (screenId: string) =>
        api.addScreenToGroup(id, screenId, csrf),
      onSuccess: () => {
        toast.add({ title: "Screen added to Display Group.", type: "success" });
        return refresh();
      },
    }),
    remove = useMutation({
      mutationFn: (screenId: string) =>
        api.removeScreenFromGroup(id, screenId, csrf),
      onSuccess: () => {
        toast.add({
          title: "Screen removed from Display Group.",
          type: "success",
        });
        return refresh();
      },
    }),
    update = useMutation({
      mutationFn: (value: {
        name: string;
        description: string;
        presentationGatewayScreenId?: string;
        clearPresentationGateway?: boolean;
      }) => api.updateScreenGroup(id, value, csrf),
      onSuccess: () => {
        toast.add({ title: "Display Group updated.", type: "success" });
        return refresh();
      },
    }),
    deleteGroup = useMutation({
      mutationFn: () => api.deleteScreenGroup(id, csrf),
      onSuccess: () => {
        toast.add({ title: "Display Group deleted.", type: "success" });
        void navigate("/groups");
      },
    }),
    assignContent = useMutation({
      mutationFn: (value: string) => {
        const [type, presentationId] = value.split(":");
        if (type === "layout" && presentationId)
          return api.assignSyncGroupLayout(id, presentationId, csrf);
        if (type === "playlist" && presentationId)
          return api.assignSyncGroupPlaylist(id, presentationId, csrf);
        return api.unassignSyncGroupPlaylist(id, csrf);
      },
      onSuccess: () => {
        toast.add({
          title: "Display Group assignment updated.",
          type: "success",
        });
        return refresh();
      },
    });
  useEffect(() => {
    setSelectedPresentation(
      group.data?.layoutId
        ? `layout:${group.data.layoutId}`
        : group.data?.playlistId
          ? `playlist:${group.data.playlistId}`
          : "",
    );
  }, [group.data?.layoutId, group.data?.playlistId]);
  if (!group.data)
    return (
      <div className="grid gap-2" aria-label={t("groups.detail.loading")}>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  const groupData = group.data;
  const fallbackOptionLabel = (value: string) => {
    const [type, id] = value.split(":");
    if (type === "playlist") {
      const found = playlists.data?.items?.find((item) => item.id === id);
      return found
        ? t("groups.detail.optionPlaylist", { name: found.name })
        : value;
    }
    if (type === "layout") {
      const found = layouts.data?.items?.find((item) => item.id === id);
      return found
        ? t("groups.detail.optionLayout", { name: found.name })
        : value;
    }
    return value;
  };
  const assignedElsewhere = new Set(
    (groups.data?.items ?? [])
      .filter((candidate) => candidate.id !== id)
      .flatMap((candidate) =>
        (candidate.screens ?? []).map((screen) => screen.id),
      ),
  );
  const available =
    (screens.data?.items ?? [])
      .filter(
        (screen) =>
          !(groupData.screens ?? []).some((member) => member.id === screen.id),
      )
      .filter((screen) => !assignedElsewhere.has(screen.id))
      .filter((screen) =>
        `${screen.name} ${screen.location}`
          .toLowerCase()
          .includes(screenSearch.toLowerCase()),
      ) ?? [];
  const savedPresentation = groupData.layoutId
    ? `layout:${groupData.layoutId}`
    : groupData.playlistId
      ? `playlist:${groupData.playlistId}`
      : "";

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {groupData.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {groupData.description || t("groups.detail.descriptionFallback")}
          </p>
        </div>
        {manageable && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setEditOpen(true)}
            >
              {t("groups.detail.edit")}
            </Button>
            {editOpen && (
              <GroupDialog
                title={t("groups.detail.edit")}
                action={t("common:actions.saveChanges")}
                initial={{
                  name: groupData.name,
                  description: groupData.description,
                }}
                pending={update.isPending}
                onClose={() => setEditOpen(false)}
                onSave={(value) => {
                  update.mutate(value);
                  setEditOpen(false);
                }}
              />
            )}
            <Button type="button" onClick={() => setAirplayOpen(true)}>
              {t("groups.detail.present")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setQuickPresentOpen(true)}
            >
              {t("groups.detail.showNow")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                void confirm({
                  title: t("groups.detail.deleteTitle", {
                    name: groupData.name,
                  }),
                  body: t("groups.detail.deleteBody"),
                  action: t("common:actions.delete"),
                  destructive: true,
                }).then((ok) => {
                  if (ok) deleteGroup.mutate();
                });
              }}
            >
              {t("groups.detail.delete")}
            </Button>
            {confirmDialog}
          </div>
        )}
      </header>
      <AirPlayPresentDialog
        open={airplayOpen}
        targetType="group"
        targetId={groupData.id}
        destinationName={groupData.name}
        displayCount={groupData.membershipCount}
        csrfToken={csrf}
        capabilities={groupAirplayCapabilities}
        capabilityLoading={groupAirplayLoading}
        capabilityError={groupAirplayError}
        audioDisplayName={
          groupData.presentationGatewayScreenId
            ? groupData.screens.find(
                (screen) => screen.id === groupData.presentationGatewayScreenId,
              )?.name
            : t("groups.detail.audioAutomatic")
        }
        onClose={() => setAirplayOpen(false)}
      />
      <QuickPresentDialog
        open={quickPresentOpen}
        targetType="group"
        targetId={groupData.id}
        destinationName={groupData.name}
        csrfToken={csrf}
        onClose={() => setQuickPresentOpen(false)}
      />

      <section className="grid gap-3 rounded-xl border border-border p-4">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">
              {t("groups.detail.screensLabel")}
            </dt>
            <dd>{groupData.membershipCount}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">
              {t("groups.detail.modeLabel")}
            </dt>
            <dd>
              {groupData.displayMode === "span"
                ? t("groups.detail.modeSpan")
                : t("groups.detail.modeMirror")}
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">
              {t("groups.detail.fallbackLabel")}
            </dt>
            <dd className="flex flex-wrap gap-x-2">
              <span>{groupFallbackType(groupData, t)}</span>
              <strong>{groupFallbackName(groupData, t)}</strong>
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">
              {t("groups.detail.updatedLabel")}
            </dt>
            <dd>{formatGroupDate(groupData.updatedAt, t, formatLocale)}</dd>
          </div>
        </dl>
      </section>

      <SpanWallEditor
        group={groupData}
        manageable={manageable}
        csrfToken={csrf}
      />

      <DisplayControlGroupActions
        groupId={groupData.id}
        memberCount={groupData.membershipCount}
        manageable={manageable}
        csrfToken={csrf}
      />

      {manageable && groupData.screens.length > 0 && (
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("groups.detail.gatewayTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("groups.detail.gatewayDescription")}
            </p>
          </header>
          <Field>
            <FieldLabel htmlFor="group-gateway">
              {t("groups.detail.gatewayLabel")}
            </FieldLabel>
            <Select
              items={[
                { value: "automatic", label: "Automatic" },
                ...groupData.screens.map((screen) => ({
                  value: screen.id,
                  label: screen.name,
                })),
              ]}
              value={groupData.presentationGatewayScreenId || "automatic"}
              onValueChange={(next) => {
                if (!next || next === "automatic") {
                  update.mutate({
                    name: groupData.name,
                    description: groupData.description,
                    clearPresentationGateway: true,
                  });
                  return;
                }
                update.mutate({
                  name: groupData.name,
                  description: groupData.description,
                  presentationGatewayScreenId: next,
                });
              }}
              disabled={update.isPending}
            >
              <SelectTrigger
                id="group-gateway"
                aria-label={t("groups.detail.gatewayLabel")}
              >
                <SelectValue>
                  {groupData.presentationGatewayScreenId
                    ? (groupData.screens.find(
                        (screen) =>
                          screen.id === groupData.presentationGatewayScreenId,
                      )?.name ?? groupData.presentationGatewayScreenId)
                    : t("groups.detail.gatewayAutomatic")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="automatic">
                  {t("groups.detail.gatewayAutomatic")}
                </SelectItem>
                {groupData.screens.map((screen) => (
                  <SelectItem key={screen.id} value={screen.id}>
                    {screen.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </section>
      )}

      <section className="grid gap-3 rounded-xl border border-border p-4">
        <header className="grid gap-1">
          <h3 className="text-base font-semibold">
            {t("groups.detail.syncTitle")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("groups.detail.syncDescription")}
          </p>
        </header>
        {manageable ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field className="min-w-52 flex-1">
              <FieldLabel htmlFor="group-fallback">
                {t("groups.detail.fallbackFieldLabel")}
              </FieldLabel>
              <Select
                items={[
                  { value: "none", label: "No fallback presentation" },
                  ...(playlists.data?.items ?? []).map((playlist) => ({
                    value: `playlist:${playlist.id}`,
                    label: `Playlist · ${playlist.name}`,
                  })),
                  ...(layouts.data?.items ?? [])
                    .filter((layout) => layout.publishedRevision)
                    .map((layout) => ({
                      value: `layout:${layout.id}`,
                      label: `Layout · ${layout.name}`,
                    })),
                ]}
                value={selectedPresentation || "none"}
                onValueChange={(next) =>
                  setSelectedPresentation(!next || next === "none" ? "" : next)
                }
              >
                <SelectTrigger
                  id="group-fallback"
                  aria-label={t("groups.detail.fallbackFieldLabel")}
                >
                  <SelectValue>
                    {selectedPresentation
                      ? fallbackOptionLabel(selectedPresentation)
                      : t("groups.detail.noFallbackOption")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {t("groups.detail.noFallbackOption")}
                  </SelectItem>
                  {playlists.data?.items?.map((playlist) => (
                    <SelectItem
                      key={playlist.id}
                      value={`playlist:${playlist.id}`}
                    >
                      {t("groups.detail.optionPlaylist", {
                        name: playlist.name,
                      })}
                    </SelectItem>
                  ))}
                  {layouts.data?.items
                    .filter((layout) => layout.publishedRevision)
                    .map((layout) => (
                      <SelectItem key={layout.id} value={`layout:${layout.id}`}>
                        {t("groups.detail.optionLayout", {
                          name: layout.name,
                        })}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
            <Button
              type="button"
              disabled={
                assignContent.isPending ||
                selectedPresentation === savedPresentation
              }
              onClick={() => assignContent.mutate(selectedPresentation)}
            >
              {assignContent.isPending
                ? t("groups.detail.applying")
                : t("groups.detail.apply")}
            </Button>
          </div>
        ) : (
          <p className="flex flex-wrap gap-x-2 text-sm">
            <span className="text-muted-foreground">
              {groupFallbackType(groupData, t)}
            </span>
            <strong>{groupFallbackName(groupData, t)}</strong>
          </p>
        )}
      </section>

      <section className="grid gap-3 rounded-xl border border-border p-4">
        <header className="grid gap-1">
          <h3 className="text-base font-semibold">
            {t("groups.detail.screensLabel")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("groups.detail.membersSummary", {
              count: groupData.membershipCount,
            })}
          </p>
        </header>
        {manageable && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="group-screen-search">
                {t("groups.detail.searchLabel")}
              </FieldLabel>
              <Input
                id="group-screen-search"
                type="search"
                placeholder={t("groups.detail.searchPlaceholder")}
                value={screenSearch}
                onChange={(event) => setScreenSearch(event.target.value)}
              />
              <FieldDescription>
                {t("groups.detail.searchHint")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="group-add-screen">
                {t("groups.detail.addLabel")}
              </FieldLabel>
              <Select
                items={available.map((screen) => ({
                  value: screen.id,
                  label: `${screen.name}${screen.location ? ` — ${screen.location}` : ""}`,
                }))}
                value=""
                disabled={available.length === 0 || add.isPending}
                onValueChange={(next) => {
                  if (next) add.mutate(next);
                }}
              >
                <SelectTrigger
                  id="group-add-screen"
                  aria-label={t("groups.detail.addLabel")}
                >
                  <SelectValue>
                    {available.length
                      ? t("groups.detail.chooseOption")
                      : t("groups.detail.noOptions")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {available.map((screen) => (
                    <SelectItem value={screen.id} key={screen.id}>
                      {screen.name}
                      {screen.location ? ` — ${screen.location}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        )}
        <div className="grid gap-2">
          {(groupData.screens ?? []).map((screen) => (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3"
              key={screen.id}
            >
              <span className="grid min-w-0 gap-0.5">
                <strong className="truncate text-sm">{screen.name}</strong>
                <small className="truncate text-xs text-muted-foreground">
                  {screen.location || t("groups.detail.noLocation")}
                </small>
              </span>
              {manageable && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(screen.id)}
                >
                  {t("groups.detail.removeOption")}
                </Button>
              )}
            </div>
          ))}
          {groupData.screens.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("groups.detail.emptyTitle")}</EmptyTitle>
                <EmptyDescription>
                  {t("groups.detail.emptyDescription")}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </section>

      <PlayerPolicyEditor target="group" id={id} />
    </section>
  );
}

export function SchedulesPage() {
  const auth = useAuth();
  const { t } = useTranslation("schedules");
  const formatLocale = useFormatLocale();
  const q = useQuery({
    queryKey: ["schedules"],
    queryFn: () => api.schedules(),
  });
  const enabledCount = (q.data?.items ?? []).filter(
    (schedule) => schedule.enabled,
  ).length;
  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("page.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("page.subtitle")}
          </p>
        </div>
        {canManage(auth.status?.user?.role) && (
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/schedules/new" className={buttonVariants()}>
              {t("page.create")}
            </Link>
          </div>
        )}
      </header>
      <section className="grid gap-1 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">{t("page.timelineTitle")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("page.timelineSummary", { count: enabledCount })}
        </p>
      </section>
      {q.isLoading && (
        <div className="grid gap-2" aria-label={t("page.loading")}>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {q.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("page.loadError")}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-2">
        {q.data?.items?.map((schedule) => (
          <Link
            className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-border p-3 hover:bg-muted ${schedule.enabled ? "" : "opacity-60"}`}
            to={`/schedules/${schedule.id}`}
            key={schedule.id}
          >
            <span className="grid min-w-0 gap-0.5">
              <strong className="truncate text-sm">{schedule.name}</strong>
              <small className="truncate text-xs text-muted-foreground">
                {schedule.enabled ? t("page.enabled") : t("page.disabled")}
              </small>
            </span>
            <span className="text-sm">{schedule.playlistName}</span>
            <span className="text-sm text-muted-foreground">
              {schedule.targets.map((target) => target.name).join(", ")}
            </span>
            <span className="text-sm text-muted-foreground">
              {schedule.type === "weekly"
                ? `${schedule.dailyStart}–${schedule.dailyEnd} · ${schedule.timezone}`
                : `${new Date(schedule.oneTimeStart!).toLocaleString(formatLocale)}–${new Date(schedule.oneTimeEnd!).toLocaleString(formatLocale)}`}
            </span>
            <Badge variant="secondary">
              {t("page.priorityBadge", { priority: schedule.priority })}
            </Badge>
          </Link>
        ))}
        {q.data?.items?.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t("page.emptyTitle")}</EmptyTitle>
              <EmptyDescription>{t("page.emptyDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </section>
  );
}

export { ScheduleEditorPage } from "../schedules/ScheduleBuilder";

function GroupDialog({
  title,
  action,
  initial,
  pending,
  onClose,
  onSave,
}: {
  title: string;
  action: string;
  initial: { name: string; description: string };
  pending: boolean;
  onClose: () => void;
  onSave: (value: { name: string; description: string }) => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) onSave({ name: name.trim(), description });
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <Field>
              <FieldLabel htmlFor="group-name">
                {t("groups.detail.dialogNameLabel")}
              </FieldLabel>
              <Input
                id="group-name"
                value={name}
                autoFocus
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="group-description">
                {t("groups.detail.dialogDescriptionLabel")}
              </FieldLabel>
              <Input
                id="group-description"
                value={description}
                maxLength={500}
                onChange={(event) => setDescription(event.target.value)}
              />
              <FieldDescription>
                {t("groups.detail.dialogDescriptionHint")}
              </FieldDescription>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || pending}>
              {pending ? t("common:actions.saving") : action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
