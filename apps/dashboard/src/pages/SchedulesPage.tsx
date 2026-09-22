import {
  Button,
  EmptyState,
  Field,
  PageHeader,
  Panel,
  SectionHeader,
  Select,
  StatusBadge,
} from "../components/ui";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import type { ScreenGroup } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";
import { PlayerPolicyEditor } from "../settings/PlayerPolicyEditor";
import { AirPlayPresentDialog } from "../components/AirPlayPresentDialog";
import { QuickPresentDialog } from "../components/QuickPresentDialog";
import { SpanWallEditor } from "../components/SpanWallEditor";
import { DisplayControlGroupActions } from "../components/DisplayControlGroupActions";
import { ScreenManagementTabs } from "../components/ScreenManagementTabs";

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
  const { confirm, prompt } = useSpectrumDialogs();
  const auth = useAuth(),
    csrf = auth.status?.csrfToken ?? "",
    client = useQueryClient();
  const manageable = canManage(auth.status?.user?.role);
  const q = useQuery({
    queryKey: ["screen-groups"],
    queryFn: () => api.screenGroups(),
  });
  const create = useMutation({
    mutationFn: (name: string) =>
      api.createScreenGroup({ name, description: "" }, csrf),
    onSuccess: () => client.invalidateQueries({ queryKey: ["screen-groups"] }),
  });
  const createGroup = async () => {
    const name = await prompt({
      title: "Create Display Group",
      description: "Choose a name that helps operators identify this group.",
      label: "Group name",
      confirmLabel: "Create group",
    });
    if (name?.trim()) create.mutate(name.trim());
  };

  return (
    <section className="sync-groups-page">
      <PageHeader
        title="Display Groups"
        description="Keep a set of screens on the same content, schedule, and playback position. Mirror groups preserve synchronized playback."
        actions={
          manageable ? (
            <Button variant="primary" onClick={createGroup}>
              Create Display Group
            </Button>
          ) : undefined
        }
      />
      <ScreenManagementTabs current="groups" className="sync-groups-tabs" />
      {q.isError && (
        <div className="notice notice--error" role="alert">
          Display Groups could not be loaded. Try refreshing the page.
        </div>
      )}
      {q.isLoading && (
        <div className="table-loading">Loading Display Groups…</div>
      )}
      <div className="sync-group-grid">
        {q.data?.items?.map((group) => (
          <Link
            className="sync-group-card"
            to={`/groups/${group.id}`}
            key={group.id}
          >
            <header className="sync-group-card__header">
              <span className="sync-group-card__title">
                <strong>{group.name}</strong>
                <small>{group.description || "No description"}</small>
              </span>
              <StatusBadge
                label={`${group.membershipCount} screen${group.membershipCount === 1 ? "" : "s"}`}
                tone={group.membershipCount > 0 ? "info" : "neutral"}
              />
            </header>
            <dl className="sync-group-card__details">
              <div>
                <dt>Fallback</dt>
                <dd>
                  <span>{groupFallbackType(group)}</span>
                  <strong>{groupFallbackName(group)}</strong>
                </dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatGroupDate(group.updatedAt)}</dd>
              </div>
            </dl>
            <p className="sync-group-card__members">
              {groupMemberSummary(group)}
            </p>
            <span className="sync-group-card__open">View group</span>
          </Link>
        ))}
      </div>
      {q.data?.items?.length === 0 && (
        <EmptyState
          className="sync-groups-empty"
          title="No Display Groups yet"
          message="Create a Display Group for screens that should always share content, schedules, and playback position."
          action={
            manageable ? (
              <Button variant="primary" onClick={createGroup}>
                Create Display Group
              </Button>
            ) : undefined
          }
        />
      )}
    </section>
  );
}

export function GroupDetailPage() {
  const { confirm, prompt } = useSpectrumDialogs();
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
  if (!group.data) return <div className="table-loading">Loading group…</div>;
  const groupData = group.data;
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
    <section className="sync-group-detail">
      <PageHeader
        title={groupData.name}
        description={
          groupData.description ||
          "Screens in this group share fallback content, schedules, and playback position."
        }
        actions={
          manageable ? (
            <>
              <Button
                variant="quiet"
                onClick={async () => {
                  const name = await prompt({
                    title: "Edit Display Group",
                    label: "Group name",
                    defaultValue: groupData.name,
                    confirmLabel: "Continue",
                  });
                  if (name?.trim()) {
                    const description = await prompt({
                      title: "Display Group description",
                      label: "Description",
                      defaultValue: groupData.description,
                      confirmLabel: "Save group",
                    });
                    if (description === null) return;
                    update.mutate({
                      name: name.trim(),
                      description,
                    });
                  }
                }}
              >
                Edit Display Group
              </Button>
              <Button variant="primary" onClick={() => setAirplayOpen(true)}>
                Present · AirPlay
              </Button>
              <Button
                variant="secondary"
                onClick={() => setQuickPresentOpen(true)}
              >
                Show now
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  if (await confirm({
                    title: `Delete ${groupData.name}?`,
                    description: "Screens in this group will not be deleted.",
                    confirmLabel: "Delete group",
                    tone: "negative",
                  }))
                    deleteGroup.mutate();
                }}
              >
                Delete Display Group
              </Button>
            </>
          ) : undefined
        }
      />
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
      <ScreenManagementTabs current="groups" className="sync-groups-tabs" />

      <Panel className="sync-group-overview">
        <dl>
          <div>
            <dt>Screens</dt>
            <dd>{groupData.membershipCount}</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>{groupData.displayMode === "span" ? "Span" : "Mirror"}</dd>
          </div>
          <div>
            <dt>Fallback content</dt>
            <dd>
              <span>{groupFallbackType(groupData)}</span>
              <strong>{groupFallbackName(groupData)}</strong>
            </dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd>{formatGroupDate(groupData.updatedAt)}</dd>
          </div>
        </dl>
      </Panel>

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
        <Panel className="sync-group-panel">
          <SectionHeader
            title="AirPlay gateway"
            description="The preferred gateway is stable across sessions. Automatic selection uses online Linux capability, hardware decode, wired link, then screen name."
          />
          <Field label="Preferred presentation gateway">
            <Select
              value={groupData.presentationGatewayScreenId ?? ""}
              onChange={(event) => {
                if (!event.target.value) {
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
                  presentationGatewayScreenId: event.target.value,
                });
              }}
              disabled={update.isPending}
            >
              <option value="">Automatic</option>
              {groupData.screens.map((screen) => (
                <option key={screen.id} value={screen.id}>
                  {screen.name}
                </option>
              ))}
            </Select>
          </Field>
        </Panel>
      )}

      <Panel className="sync-group-panel">
        <SectionHeader
          title="Synchronized content"
          description="Every screen in this group uses this fallback content whenever no higher-priority schedule or takeover is active."
        />
        {manageable ? (
          <div className="sync-group-content-controls">
            <Select
              aria-label="Display Group fallback content"
              value={selectedPresentation}
              onChange={(event) => setSelectedPresentation(event.target.value)}
            >
              <option value="">No fallback presentation</option>
              <optgroup label="Playlists">
                {playlists.data?.items?.map((playlist) => (
                  <option key={playlist.id} value={`playlist:${playlist.id}`}>
                    {playlist.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Published layouts">
                {layouts.data?.items
                  .filter((layout) => layout.publishedRevision)
                  .map((layout) => (
                    <option key={layout.id} value={`layout:${layout.id}`}>
                      {layout.name}
                    </option>
                  ))}
              </optgroup>
            </Select>
            <Button
              variant="primary"
              loading={assignContent.isPending}
              disabled={selectedPresentation === savedPresentation}
              onClick={() => assignContent.mutate(selectedPresentation)}
            >
              Apply to Display Group
            </Button>
          </div>
        ) : (
          <div className="sync-group-current-content">
            <span>{groupFallbackType(groupData)}</span>
            <strong>{groupFallbackName(groupData)}</strong>
          </div>
        )}
      </Panel>

      <Panel className="sync-group-panel sync-group-screens-panel">
        <SectionHeader
          title="Screens"
          description={`${groupData.membershipCount} screen${groupData.membershipCount === 1 ? "" : "s"} currently share this group's playback state.`}
        />
        {manageable && (
          <div className="sync-group-add-controls">
            <Field
              label="Search available screens"
              description="Screens already assigned to another Display Group are excluded."
            >
              <input
                type="search"
                placeholder="Name or location"
                value={screenSearch}
                onChange={(event) => setScreenSearch(event.target.value)}
              />
            </Field>
            <Field label="Add screen">
              <Select
                value=""
                disabled={available.length === 0 || add.isPending}
                onChange={(event) => {
                  if (event.target.value) add.mutate(event.target.value);
                }}
              >
                <option value="">
                  {available.length
                    ? "Choose a screen…"
                    : "No matching screens"}
                </option>
                {available.map((screen) => (
                  <option value={screen.id} key={screen.id}>
                    {screen.name}
                    {screen.location ? ` — ${screen.location}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <div className="sync-group-members">
          {(groupData.screens ?? []).map((screen) => (
            <div className="sync-group-member" key={screen.id}>
              <span>
                <strong>{screen.name}</strong>
                <small>{screen.location || "No location assigned"}</small>
              </span>
              {manageable && (
                <Button
                  variant="quiet"
                  compact
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(screen.id)}
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
          {groupData.screens.length === 0 && (
            <div className="sync-group-members__empty">
              <strong>No screens in this group</strong>
              <span>
                Add an available screen above to begin synchronized playback.
              </span>
            </div>
          )}
        </div>
      </Panel>

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
    <section>
      <PageHeader
        title="Schedules"
        description="Higher priority wins. Screens in a Display Group always share the same schedule and fallback content."
        actions={
          canManage(auth.status?.user?.role) ? (
            <Link className="button button--primary" to="/schedules/new">
              Create schedule
            </Link>
          ) : undefined
        }
      />
      <div className="schedule-today">
        <h3>Schedule timeline</h3>
        <p>
          {(q.data?.items ?? []).filter((schedule) => schedule.enabled).length}{" "}
          enabled · times evaluate in each schedule’s IANA timezone · overnight
          windows continue into the next day
        </p>
      </div>
      <div className="schedule-list">
        {q.data?.items?.map((schedule) => (
          <Link
            className={`schedule-card ${schedule.enabled ? "" : "schedule-card--disabled"}`}
            to={`/schedules/${schedule.id}`}
            key={schedule.id}
          >
            <span>
              <strong>{schedule.name}</strong>
              <small>{schedule.enabled ? "Enabled" : "Disabled"}</small>
            </span>
            <span>{schedule.playlistName}</span>
            <span>
              {schedule.targets.map((target) => target.name).join(", ")}
            </span>
            <span>
              {schedule.type === "weekly"
                ? `${schedule.dailyStart}–${schedule.dailyEnd} · ${schedule.timezone}`
                : `${new Date(schedule.oneTimeStart!).toLocaleString()}–${new Date(schedule.oneTimeEnd!).toLocaleString()}`}
            </span>
            <b>Priority {schedule.priority}</b>
          </Link>
        ))}
        {q.data?.items?.length === 0 && (
          <div className="screen-empty">
            <h3>No schedules yet</h3>
            <p>
              Direct screen assignments will continue to play until a schedule
              is created.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

export { ScheduleEditorPage } from "../schedules/ScheduleBuilder";
