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
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import type { ScreenGroup } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { PlayerPolicyEditor } from "../settings/PlayerPolicyEditor";
import { AirPlayPresentDialog } from "../components/AirPlayPresentDialog";
import { QuickPresentDialog } from "../components/QuickPresentDialog";
import { SpanWallEditor } from "../components/SpanWallEditor";
import { DisplayControlGroupActions } from "../components/DisplayControlGroupActions";

const canManage = (role?: string) =>
  role === "owner" || role === "administrator";

function groupFallbackName(
  group: Pick<ScreenGroup, "layoutName" | "playlistName">,
) {
  return group.layoutName ?? group.playlistName ?? "No fallback content";
}

function groupFallbackType(
  group: Pick<ScreenGroup, "layoutName" | "playlistName">,
) {
  if (group.layoutName) return "Layout";
  if (group.playlistName) return "Playlist";
  return "Unassigned";
}

function groupMemberSummary(group: ScreenGroup) {
  const screens = group.screens ?? [];
  if (group.membershipCount === 0) return "No screens assigned";
  if (screens.length === 0)
    return `${group.membershipCount} screen${group.membershipCount === 1 ? "" : "s"} assigned`;
  const visible = screens.slice(0, 3).map((screen) => screen.name);
  const remaining = Math.max(0, group.membershipCount - visible.length);
  return `${visible.join(", ")}${remaining ? ` +${remaining} more` : ""}`;
}

function formatGroupDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function GroupsPage() {
  const auth = useAuth(),
    csrf = auth.status?.csrfToken ?? "",
    client = useQueryClient();
  const manageable = canManage(auth.status?.user?.role);
  const q = useQuery({
    queryKey: ["screen-groups"],
    queryFn: () => api.screenGroups(),
  });
  const [createOpen, setCreateOpen] = useState(false);
  const create = useMutation({
    mutationFn: (value: { name: string; description: string }) =>
      api.createScreenGroup(value, csrf),
    onSuccess: () => client.invalidateQueries({ queryKey: ["screen-groups"] }),
  });

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            Display Groups
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Keep a set of screens on the same content, schedule, and playback
            position. Mirror groups preserve synchronized playback.
          </p>
        </div>
        {manageable && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => setCreateOpen(true)}>
              Create Display Group
            </Button>
          </div>
        )}
      </header>
      {q.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            Display Groups could not be loaded. Try refreshing the page.
          </AlertDescription>
        </Alert>
      )}
      {q.isLoading && (
        <div className="grid gap-2" aria-label="Loading Display Groups">
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
                  {group.description || "No description"}
                </small>
              </span>
              <Badge
                variant={group.membershipCount > 0 ? "default" : "secondary"}
              >
                {group.membershipCount} screen
                {group.membershipCount === 1 ? "" : "s"}
              </Badge>
            </span>
            <dl className="grid gap-2 text-sm">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">Fallback</dt>
                <dd className="flex flex-wrap gap-x-2">
                  <span>{groupFallbackType(group)}</span>
                  <strong>{groupFallbackName(group)}</strong>
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">Updated</dt>
                <dd>{formatGroupDate(group.updatedAt)}</dd>
              </div>
            </dl>
            <span className="text-sm text-muted-foreground">
              {groupMemberSummary(group)}
            </span>
            <span className="text-sm font-medium">View group</span>
          </Link>
        ))}
      </div>
      {q.data?.items?.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutGrid size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No Display Groups yet</EmptyTitle>
            <EmptyDescription>
              Create a Display Group for screens that should always share
              content, schedules, and playback position.
              {manageable && (
                <Button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="mt-3"
                >
                  Create Display Group
                </Button>
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {createOpen && (
        <GroupDialog
          title="Create Display Group"
          action="Create group"
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
      onSuccess: refresh,
    }),
    remove = useMutation({
      mutationFn: (screenId: string) =>
        api.removeScreenFromGroup(id, screenId, csrf),
      onSuccess: refresh,
    }),
    update = useMutation({
      mutationFn: (value: {
        name: string;
        description: string;
        presentationGatewayScreenId?: string;
        clearPresentationGateway?: boolean;
      }) => api.updateScreenGroup(id, value, csrf),
      onSuccess: refresh,
    }),
    deleteGroup = useMutation({
      mutationFn: () => api.deleteScreenGroup(id, csrf),
      onSuccess: () => navigate("/groups"),
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
      onSuccess: refresh,
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
      <div className="grid gap-2" aria-label="Loading group">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  const groupData = group.data;
  const fallbackOptionLabel = (value: string) => {
    const [type, id] = value.split(":");
    if (type === "playlist") {
      const found = playlists.data?.items?.find((item) => item.id === id);
      return found ? `Playlist · ${found.name}` : value;
    }
    if (type === "layout") {
      const found = layouts.data?.items?.find((item) => item.id === id);
      return found ? `Layout · ${found.name}` : value;
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
            {groupData.description ||
              "Screens in this group share fallback content, schedules, and playback position."}
          </p>
        </div>
        {manageable && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setEditOpen(true)}
            >
              Edit Display Group
            </Button>
            {editOpen && (
              <GroupDialog
                title="Edit Display Group"
                action="Save changes"
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
              Present · AirPlay
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setQuickPresentOpen(true)}
            >
              Show now
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                void confirm({
                  title: `Delete ${groupData.name}?`,
                  body: "Screens will not be deleted.",
                  action: "Delete",
                  destructive: true,
                }).then((ok) => {
                  if (ok) deleteGroup.mutate();
                });
              }}
            >
              Delete Display Group
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
            : "Automatic gateway"
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
            <dt className="text-muted-foreground">Screens</dt>
            <dd>{groupData.membershipCount}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">Mode</dt>
            <dd>{groupData.displayMode === "span" ? "Span" : "Mirror"}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">Fallback content</dt>
            <dd className="flex flex-wrap gap-x-2">
              <span>{groupFallbackType(groupData)}</span>
              <strong>{groupFallbackName(groupData)}</strong>
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">Last updated</dt>
            <dd>{formatGroupDate(groupData.updatedAt)}</dd>
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
            <h3 className="text-base font-semibold">AirPlay gateway</h3>
            <p className="text-sm text-muted-foreground">
              The preferred gateway is stable across sessions. Automatic
              selection uses online Linux capability, hardware decode, wired
              link, then screen name.
            </p>
          </header>
          <Field>
            <FieldLabel htmlFor="group-gateway">
              Preferred presentation gateway
            </FieldLabel>
            <Select
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
                aria-label="Preferred presentation gateway"
              >
                <SelectValue>
                  {groupData.presentationGatewayScreenId
                    ? (groupData.screens.find(
                        (screen) =>
                          screen.id === groupData.presentationGatewayScreenId,
                      )?.name ?? groupData.presentationGatewayScreenId)
                    : "Automatic"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="automatic">Automatic</SelectItem>
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
          <h3 className="text-base font-semibold">Synchronized content</h3>
          <p className="text-sm text-muted-foreground">
            Every screen in this group uses this fallback content whenever no
            higher-priority schedule or takeover is active.
          </p>
        </header>
        {manageable ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field className="min-w-52 flex-1">
              <FieldLabel htmlFor="group-fallback">
                Display Group fallback content
              </FieldLabel>
              <Select
                value={selectedPresentation || "none"}
                onValueChange={(next) =>
                  setSelectedPresentation(!next || next === "none" ? "" : next)
                }
              >
                <SelectTrigger
                  id="group-fallback"
                  aria-label="Display Group fallback content"
                >
                  <SelectValue>
                    {selectedPresentation
                      ? fallbackOptionLabel(selectedPresentation)
                      : "No fallback presentation"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No fallback presentation</SelectItem>
                  {playlists.data?.items?.map((playlist) => (
                    <SelectItem
                      key={playlist.id}
                      value={`playlist:${playlist.id}`}
                    >
                      Playlist · {playlist.name}
                    </SelectItem>
                  ))}
                  {layouts.data?.items
                    .filter((layout) => layout.publishedRevision)
                    .map((layout) => (
                      <SelectItem key={layout.id} value={`layout:${layout.id}`}>
                        Layout · {layout.name}
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
              {assignContent.isPending ? "Applying…" : "Apply to Display Group"}
            </Button>
          </div>
        ) : (
          <p className="flex flex-wrap gap-x-2 text-sm">
            <span className="text-muted-foreground">
              {groupFallbackType(groupData)}
            </span>
            <strong>{groupFallbackName(groupData)}</strong>
          </p>
        )}
      </section>

      <section className="grid gap-3 rounded-xl border border-border p-4">
        <header className="grid gap-1">
          <h3 className="text-base font-semibold">Screens</h3>
          <p className="text-sm text-muted-foreground">
            {groupData.membershipCount} screen
            {groupData.membershipCount === 1 ? "" : "s"} currently share this
            group&apos;s playback state.
          </p>
        </header>
        {manageable && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="group-screen-search">
                Search available screens
              </FieldLabel>
              <Input
                id="group-screen-search"
                type="search"
                placeholder="Name or location"
                value={screenSearch}
                onChange={(event) => setScreenSearch(event.target.value)}
              />
              <FieldDescription>
                Screens already assigned to another Display Group are excluded.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="group-add-screen">Add screen</FieldLabel>
              <Select
                value=""
                disabled={available.length === 0 || add.isPending}
                onValueChange={(next) => {
                  if (next) add.mutate(next);
                }}
              >
                <SelectTrigger id="group-add-screen" aria-label="Add screen">
                  <SelectValue>
                    {available.length
                      ? "Choose a screen…"
                      : "No matching screens"}
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
                  {screen.location || "No location assigned"}
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
                  Remove
                </Button>
              )}
            </div>
          ))}
          {groupData.screens.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No screens in this group</EmptyTitle>
                <EmptyDescription>
                  Add an available screen above to begin synchronized playback.
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
  const q = useQuery({
    queryKey: ["schedules"],
    queryFn: () => api.schedules(),
  });
  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Schedules</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Higher priority wins. Screens in a Display Group always share the
            same schedule and fallback content.
          </p>
        </div>
        {canManage(auth.status?.user?.role) && (
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/schedules/new" className={buttonVariants()}>
              Create schedule
            </Link>
          </div>
        )}
      </header>
      <section className="grid gap-1 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">Schedule timeline</h2>
        <p className="text-sm text-muted-foreground">
          {(q.data?.items ?? []).filter((schedule) => schedule.enabled).length}{" "}
          enabled · times evaluate in each schedule’s IANA timezone · overnight
          windows continue into the next day
        </p>
      </section>
      {q.isLoading && (
        <div className="grid gap-2" aria-label="Loading schedules">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {q.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            Schedules could not be loaded. Try refreshing the page.
          </AlertDescription>
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
                {schedule.enabled ? "Enabled" : "Disabled"}
              </small>
            </span>
            <span className="text-sm">{schedule.playlistName}</span>
            <span className="text-sm text-muted-foreground">
              {schedule.targets.map((target) => target.name).join(", ")}
            </span>
            <span className="text-sm text-muted-foreground">
              {schedule.type === "weekly"
                ? `${schedule.dailyStart}–${schedule.dailyEnd} · ${schedule.timezone}`
                : `${new Date(schedule.oneTimeStart!).toLocaleString()}–${new Date(schedule.oneTimeEnd!).toLocaleString()}`}
            </span>
            <Badge variant="secondary">Priority {schedule.priority}</Badge>
          </Link>
        ))}
        {q.data?.items?.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No schedules yet</EmptyTitle>
              <EmptyDescription>
                Direct screen assignments will continue to play until a schedule
                is created.
              </EmptyDescription>
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
              <FieldLabel htmlFor="group-name">Group name</FieldLabel>
              <Input
                id="group-name"
                value={name}
                autoFocus
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="group-description">Description</FieldLabel>
              <Input
                id="group-description"
                value={description}
                maxLength={500}
                onChange={(event) => setDescription(event.target.value)}
              />
              <FieldDescription>
                Screens in this group share fallback content, schedules, and
                playback position.
              </FieldDescription>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || pending}>
              {pending ? "Saving…" : action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
