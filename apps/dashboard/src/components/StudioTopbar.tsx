import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import {
  matchRoutes,
  useLocation,
  useNavigate,
  type RouteObject,
} from "react-router";
import {
  Breadcrumb,
  Breadcrumbs,
} from "@react-spectrum/s2/Breadcrumbs";
import { Button } from "@react-spectrum/s2/Button";
import { LinkButton } from "@react-spectrum/s2/LinkButton";
import { Dialog, DialogContainer } from "@react-spectrum/s2/Dialog";
import { Autocomplete } from "@react-spectrum/s2/Autocomplete";
import { Content } from "@react-spectrum/s2/Content";
import { Heading } from "@react-spectrum/s2/Heading";
import { Text } from "@react-spectrum/s2/Text";
import { ActionButton } from "@react-spectrum/s2/ActionButton";
import { Link } from "@react-spectrum/s2/Link";
import {
  Header,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
} from "@react-spectrum/s2/Menu";
import { Popover, DialogTrigger } from "@react-spectrum/s2/Popover";
import { SearchField } from "@react-spectrum/s2/SearchField";
import { StatusLight } from "@react-spectrum/s2/StatusLight";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import AddIcon from "@react-spectrum/s2/icons/Add";
import AppsIcon from "@react-spectrum/s2/icons/Apps";
import BellIcon from "@react-spectrum/s2/icons/Bell";
import CalendarIcon from "@react-spectrum/s2/icons/Calendar";
import ChevronRightIcon from "@react-spectrum/s2/icons/ChevronRight";
import ClockIcon from "@react-spectrum/s2/icons/Clock";
import DataIcon from "@react-spectrum/s2/icons/Data";
import DeviceDesktopIcon from "@react-spectrum/s2/icons/DeviceDesktop";
import FilesIcon from "@react-spectrum/s2/icons/Files";
import ImageIcon from "@react-spectrum/s2/icons/Image";
import LayersIcon from "@react-spectrum/s2/icons/Layers";
import ListBulletedIcon from "@react-spectrum/s2/icons/ListBulleted";
import PluginIcon from "@react-spectrum/s2/icons/Plugin";
import SearchIcon from "@react-spectrum/s2/icons/Search";
import SettingsIcon from "@react-spectrum/s2/icons/Settings";
import UploadIcon from "@react-spectrum/s2/icons/Upload";
import UserIcon from "@react-spectrum/s2/icons/User";
import UserGroupIcon from "@react-spectrum/s2/icons/UserGroup";
import type { Screen, ScreenStatus, User } from "../api/types";
import { api } from "../api/client";
import {
  useNotifications,
  type NotificationPriority,
} from "../notifications/useNotifications";
import {
  studioRouteHandle,
  useStudioRoutes,
  type BreadcrumbResource,
} from "../navigation/studioRoutes";
import { UploadContentDialog } from "./content-picker/UploadContentDialog";

type CommandGroupName =
  | "Quick actions"
  | "Screens"
  | "Content"
  | "Presentations"
  | "Scheduling"
  | "Administration"
  | "Navigation";

type CommandAction = "upload-media";

type CommandResult = {
  id: string;
  label: string;
  description: string;
  to?: string;
  action?: CommandAction;
  category: CommandGroupName;
  icon: ReactNode;
  score: number;
};

type CommandPermissions = {
  canCreate: boolean;
  canPair: boolean;
};

type Breadcrumb = { label: string; to: string };
type CommandProvider = {
  id: string;
  results: () => (Omit<CommandResult, "score"> & { keywords?: string[] })[];
};

const topbarStyles = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  minHeight: 64,
  paddingX: { default: 16, md: 24 },
  borderBottomWidth: 1,
  borderColor: "gray-200",
  backgroundColor: "base",
  position: "sticky",
  top: 0,
  zIndex: 10,
});

const topbarActionsStyles = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "end",
  gap: 8,
  flexShrink: 0,
});

const searchDialogStyles = style({
  display: "flex",
  flexDirection: "column",
  gap: 16,
  minWidth: { default: "min(90vw, 32rem)", md: 640 },
  maxWidth: "90vw",
});

const searchResultsStyles = style({
  display: "flex",
  flexDirection: "column",
  gap: 12,
  maxHeight: "min(65vh, 36rem)",
  overflowY: "auto",
});

const notificationListStyles = style({
  display: "flex",
  flexDirection: "column",
  gap: 12,
  maxHeight: "min(65vh, 36rem)",
  overflowY: "auto",
});

const notificationItemStyles = style({
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 12,
  paddingY: 8,
  borderBottomWidth: 1,
  borderColor: "gray-200",
});

const notificationCopyStyles = style({
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 0,
});

const statusLabels: Record<ScreenStatus, string> = {
  online: "Online",
  recent: "Recently online",
  stale: "Stale",
  offline: "Offline",
  disabled: "Disabled",
  revoked: "Pairing revoked",
};

const notificationGroups: { priority: NotificationPriority; label: string }[] =
  [
    { priority: "critical", label: "Critical" },
    { priority: "warning", label: "Needs attention" },
    { priority: "info", label: "Info" },
  ];

const notificationVariants: Record<NotificationPriority, "negative" | "notice" | "informative"> = {
  critical: "negative",
  warning: "notice",
  info: "informative",
};

const commandGroupOrder: CommandGroupName[] = [
  "Quick actions",
  "Screens",
  "Content",
  "Presentations",
  "Scheduling",
  "Administration",
  "Navigation",
];

const defaultRouteIds = new Set([
  "route:/",
  "route:/screens",
  "route:/assets",
  "route:/playlists",
  "route:/layouts",
  "route:/schedules",
]);

function platformShortcut() {
  if (typeof navigator === "undefined") return "⌘K";
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "⌘K" : "Ctrl K";
}

export function fuzzyScore(query: string, candidate: string) {
  const needle = query.trim().toLocaleLowerCase();
  const haystack = candidate.toLocaleLowerCase();
  if (!needle) return 1;
  const exactIndex = haystack.indexOf(needle);
  if (exactIndex >= 0)
    return 200 - exactIndex - (haystack.length - needle.length);

  let candidateIndex = 0;
  let gaps = 0;
  for (const character of needle) {
    const match = haystack.indexOf(character, candidateIndex);
    if (match < 0) return -1;
    gaps += match - candidateIndex;
    candidateIndex = match + 1;
  }
  return 100 - gaps - (haystack.length - needle.length);
}

function resultIcon(to: string): ReactNode {
  if (to.startsWith("/screens") || to.startsWith("/groups"))
    return <DeviceDesktopIcon aria-hidden="true" />;
  if (to.startsWith("/assets")) return <ImageIcon aria-hidden="true" />;
  if (to.startsWith("/playlists")) return <ListBulletedIcon aria-hidden="true" />;
  if (to.startsWith("/layouts")) return <LayersIcon aria-hidden="true" />;
  if (to.startsWith("/schedules")) return <CalendarIcon aria-hidden="true" />;
  if (to.startsWith("/plugins")) return <PluginIcon aria-hidden="true" />;
  if (to.startsWith("/activity")) return <ClockIcon aria-hidden="true" />;
  if (to.startsWith("/data-sources")) return <DataIcon aria-hidden="true" />;
  if (
    to.startsWith("/settings") ||
    to.startsWith("/preferences") ||
    to.startsWith("/account")
  )
    return to.startsWith("/account") ? (
      <UserIcon aria-hidden="true" />
    ) : (
      <SettingsIcon aria-hidden="true" />
    );
  return <FilesIcon aria-hidden="true" />;
}

function routeGroup(to: string): CommandGroupName {
  if (to.startsWith("/screens") || to.startsWith("/groups")) return "Screens";
  if (
    to.startsWith("/assets") ||
    to.startsWith("/widgets") ||
    to.startsWith("/data-sources")
  )
    return "Content";
  if (
    to.startsWith("/playlists") ||
    to.startsWith("/layouts") ||
    to.startsWith("/campaigns")
  )
    return "Presentations";
  if (to.startsWith("/schedules")) return "Scheduling";
  if (
    to.startsWith("/settings") ||
    to.startsWith("/preferences") ||
    to.startsWith("/account") ||
    to.startsWith("/approvals") ||
    to.startsWith("/activity")
  )
    return "Administration";
  return "Navigation";
}

function collectRouteResults(routes: readonly RouteObject[]) {
  const results: (Omit<CommandResult, "score"> & { keywords?: string[] })[] =
    [];
  const seen = new Set<string>();
  const visit = (route: RouteObject) => {
    const item = studioRouteHandle(route).search;
    if (item && !seen.has(item.to)) {
      seen.add(item.to);
      results.push({
        id: `route:${item.to}`,
        label: item.label,
        description: item.description,
        to: item.to,
        category: routeGroup(item.to),
        icon: resultIcon(item.to),
        keywords: item.keywords,
      });
    }
    route.children?.forEach(visit);
  };
  routes.forEach(visit);
  return results;
}

function collectActionResults(permissions: CommandPermissions) {
  const results: (Omit<CommandResult, "score"> & { keywords?: string[] })[] =
    [];
  if (permissions.canPair) {
    results.push({
      id: "action:pair-screen",
      label: "Pair a screen",
      description: "Connect a new signage player",
      to: "/screens/pair",
      category: "Quick actions",
      icon: <DeviceDesktopIcon aria-hidden="true" />,
      keywords: ["add screen", "new device", "player"],
    });
  }
  if (permissions.canCreate) {
    results.push(
      {
        id: "action:upload-media",
        label: "Upload media",
        description: "Add images, videos, or documents",
        action: "upload-media",
        category: "Quick actions",
        icon: <UploadIcon aria-hidden="true" />,
        keywords: ["content", "asset", "file"],
      },
      {
        id: "action:create-playlist",
        label: "Create playlist",
        description: "Build a new fullscreen presentation",
        to: "/playlists?create=1",
        category: "Quick actions",
        icon: <ListBulletedIcon aria-hidden="true" />,
        keywords: ["new presentation"],
      },
      {
        id: "action:create-layout",
        label: "Create layout",
        description: "Arrange content on a presentation canvas",
        to: "/layouts?create=1",
        category: "Quick actions",
        icon: <LayersIcon aria-hidden="true" />,
        keywords: ["new presentation", "canvas"],
      },
      {
        id: "action:create-schedule",
        label: "Create schedule",
        description: "Plan where and when content plays",
        to: "/schedules/new",
        category: "Quick actions",
        icon: <CalendarIcon aria-hidden="true" />,
        keywords: ["new deployment", "publish"],
      },
    );
  }
  return results;
}

export function buildCommandResults(
  routes: readonly RouteObject[],
  screens: Screen[],
  query: string,
  permissions: CommandPermissions = { canCreate: true, canPair: true },
) {
  const providers: CommandProvider[] = [
    { id: "actions", results: () => collectActionResults(permissions) },
    { id: "routes", results: () => collectRouteResults(routes) },
    {
      id: "screens",
      results: () =>
        screens.map((screen) => ({
          id: `screen:${screen.id}`,
          label: screen.name,
          description: `${statusLabels[screen.status]}${screen.location ? ` · ${screen.location}` : ""}`,
          to: `/screens/${screen.id}`,
          category: "Screens" as const,
          icon: <DeviceDesktopIcon aria-hidden="true" />,
          keywords: [screen.location, screen.platform, "screen", "player"].filter(Boolean),
        })),
    },
  ];

  const normalizedQuery = query.trim();
  const results = providers
    .flatMap((provider) => provider.results())
    .map((result) => ({
      ...result,
      score: fuzzyScore(
        normalizedQuery,
        [result.label, result.description, ...(result.keywords ?? [])].join(
          " ",
        ),
      ),
    }))
    .filter((result) => result.score >= 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        commandGroupOrder.indexOf(left.category) -
          commandGroupOrder.indexOf(right.category),
    ) as CommandResult[];

  if (!normalizedQuery) {
    return results.filter(
      (result) =>
        result.category === "Quick actions" || defaultRouteIds.has(result.id),
    );
  }

  return results.slice(0, 20);
}

function groupCommandResults(results: CommandResult[]) {
  return commandGroupOrder
    .map((name) => ({
      name,
      results: results.filter((result) => result.category === name),
    }))
    .filter((group) => group.results.length > 0);
}

function breadcrumbQueryKey(resource?: BreadcrumbResource, id?: string) {
  switch (resource) {
    case "screen":
      return ["screens", id] as const;
    case "screen-group":
      return ["screen-groups", id] as const;
    case "widget":
      return ["assets", id] as const;
    case "data-source":
      return ["data-source", id] as const;
    case "playlist":
      return ["playlists", id] as const;
    case "layout":
      return ["layout", id] as const;
    case "schedule":
      return ["schedules", id] as const;
    default:
      return ["breadcrumb", "none"] as const;
  }
}

function breadcrumbResource(resource: BreadcrumbResource, id: string) {
  switch (resource) {
    case "screen":
      return api.screen(id);
    case "screen-group":
      return api.screenGroup(id);
    case "widget":
      return api.asset(id);
    case "data-source":
      return api.getDataSource(id);
    case "playlist":
      return api.playlist(id);
    case "layout":
      return api.layout(id);
    case "schedule":
      return api.schedule(id);
  }
}

function breadcrumbResourceName(entity: { name?: unknown } | null | undefined) {
  return typeof entity?.name === "string" && entity.name
    ? entity.name
    : undefined;
}

function useBreadcrumbs(routes: readonly RouteObject[], pathname: string) {
  const matches = matchRoutes([...routes], pathname) ?? [];
  const breadcrumbMatches = matches.filter(
    (match) => studioRouteHandle(match.route).breadcrumb,
  );
  const resourceMatch = [...breadcrumbMatches]
    .reverse()
    .find((match) => studioRouteHandle(match.route).resource);
  const resource = resourceMatch
    ? studioRouteHandle(resourceMatch.route).resource
    : undefined;
  const resourceId = resourceMatch?.params.id;
  const resourceName = useQuery({
    queryKey: breadcrumbQueryKey(resource, resourceId),
    queryFn: () => breadcrumbResource(resource!, resourceId!),
    enabled: Boolean(resource && resourceId),
    staleTime: 30_000,
    select: breadcrumbResourceName,
  });

  return breadcrumbMatches.map((match) => {
    const handle = studioRouteHandle(match.route);
    return {
      label:
        match === resourceMatch && typeof resourceName.data === "string"
          ? resourceName.data
          : (handle.breadcrumb ?? ""),
      to: match.pathname,
    } satisfies Breadcrumb;
  });
}

function BreadcrumbTrail({ items }: { items: Breadcrumb[] }) {
  return (
    <Breadcrumbs aria-label="Breadcrumb">
      {items.map((item, index) => (
        <Breadcrumb
          key={`${item.to}:${item.label}`}
          href={index === items.length - 1 ? undefined : item.to}
        >
          {item.label}
        </Breadcrumb>
      ))}
    </Breadcrumbs>
  );
}

function isModalTextInput(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const textInput =
    target.matches(
      'input:not([type="button"]):not([type="submit"]), textarea',
    ) || target.isContentEditable;
  return textInput && Boolean(target.closest('[role="dialog"], dialog'));
}

function CommandPalette({
  open,
  onClose,
  onUpload,
  routes,
  screens,
  canCreate,
  canPair,
}: {
  open: boolean;
  onClose: () => void;
  onUpload: () => void;
  routes: readonly RouteObject[];
  screens: Screen[];
  canCreate: boolean;
  canPair: boolean;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const results = buildCommandResults(routes, screens, query, {
    canCreate,
    canPair,
  });
  const groups = groupCommandResults(results);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const select = (result: CommandResult) => {
    onClose();
    if (result.action === "upload-media") {
      onUpload();
      return;
    }
    if (result.to) void navigate(result.to);
  };

  if (!open) return null;
  return (
    <DialogContainer onDismiss={onClose}>
      <Dialog aria-label="Search Tilecast" size="L">
        <Heading slot="title">Search Tilecast</Heading>
        <Content>
          <div className={searchDialogStyles}>
            <Autocomplete
              filter={() => true}
            >
              <SearchField
                autoFocus
                aria-label="Search Tilecast"
                placeholder="Search screens, media, playlists…"
                value={query}
                onChange={setQuery}
              />
              {groups.length === 0 ? (
                <Text>
                  {query.trim()
                    ? `No results for “${query.trim()}”.`
                    : "No destinations available."}
                </Text>
              ) : (
                <div className={searchResultsStyles}>
                  <Menu aria-label="Search results">
                    {groups.map((group) => (
                      <MenuSection key={group.name} aria-label={group.name}>
                        <Header>
                          <Heading>{group.name}</Heading>
                        </Header>
                        {group.results.map((result) => (
                          <MenuItem
                            key={result.id}
                            id={result.id}
                            textValue={result.label}
                            onAction={() => select(result)}
                          >
                            {result.icon}
                            <Text slot="label">{result.label}</Text>
                            <Text slot="description">{result.description}</Text>
                          </MenuItem>
                        ))}
                      </MenuSection>
                    ))}
                  </Menu>
                </div>
              )}
            </Autocomplete>
            <Text>{`Use ↑ and ↓ to move, Enter to open, Esc to close · ${platformShortcut()}`}</Text>
          </div>
        </Content>
      </Dialog>
    </DialogContainer>
  );
}

function NotificationsPopover({ user }: { user?: User }) {
  const notifications = useNotifications(user);

  return (
    <DialogTrigger>
      <ActionButton
        aria-label={`Notifications${notifications.count ? `, ${notifications.count} active` : ""}`}
      >
        <BellIcon aria-hidden="true" />
        {notifications.count > 0 && <Text>{notifications.count}</Text>}
      </ActionButton>
      <Popover aria-label="Notifications" size="M">
        <div className={notificationListStyles}>
          <Heading level={2}>Notifications</Heading>
          {notifications.count === 0 ? (
            <Text>You&rsquo;re all caught up.</Text>
          ) : (
            notificationGroups.map((group) => {
              const items = notifications.items.filter(
                (item) => item.priority === group.priority,
              );
              if (items.length === 0) return null;
              return (
                <section key={group.priority} aria-label={group.label}>
                  <Heading level={3}>{group.label}</Heading>
                  {items.map((item) => (
                    <div className={notificationItemStyles} key={item.id}>
                      <div className={notificationCopyStyles}>
                        <StatusLight variant={notificationVariants[item.priority]}>
                          {item.title}
                        </StatusLight>
                        <Text>{item.detail}</Text>
                      </div>
                      <Link aria-label={`Open ${item.title}`} href={item.to}>
                        <ChevronRightIcon aria-hidden="true" />
                      </Link>
                    </div>
                  ))}
                </section>
              );
            })
          )}
        </div>
      </Popover>
    </DialogTrigger>
  );
}

export function StudioTopbar({
  user,
  csrfToken = "",
}: {
  user?: User;
  csrfToken?: string;
}) {
  const routes = useStudioRoutes();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const breadcrumbs = useBreadcrumbs(routes, location.pathname);
  const screens = useQuery({
    queryKey: ["screens"],
    queryFn: api.screens,
    refetchInterval: 10_000,
  });
  const canPair = user?.role === "owner" || user?.role === "administrator";
  const canCreate = user?.role !== "viewer";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLocaleLowerCase() === "k" &&
        (event.metaKey || event.ctrlKey) &&
        !isModalTextInput(event.target)
      ) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setPaletteOpen(false);
  }, [location.pathname]);

  return (
    <header className={topbarStyles}>
      <div>
        {breadcrumbs.length > 1 && <BreadcrumbTrail items={breadcrumbs} />}
      </div>
      <div className={topbarActionsStyles}>
        <ActionButton
          aria-label={`Search Tilecast (${platformShortcut()})`}
          onPress={() => setPaletteOpen(true)}
        >
          <SearchIcon aria-hidden="true" />
          <Text>Search Tilecast</Text>
          <Text>{platformShortcut()}</Text>
        </ActionButton>
        <NotificationsPopover user={user} />
        {canPair && (
          <LinkButton href="/screens/pair" variant="secondary">
            <DeviceDesktopIcon aria-hidden="true" />
            <Text>Pair screen</Text>
          </LinkButton>
        )}
        {canCreate && (
          <MenuTrigger align="end">
            <Button variant="primary">
              <AddIcon aria-hidden="true" />
              <Text>Create</Text>
            </Button>
            <Menu
              aria-label="Create"
              onAction={(key) => {
                if (key === "upload") setUploadOpen(true);
              }}
            >
              <MenuSection aria-label="Create content">
                <MenuItem id="upload">
                  <UploadIcon aria-hidden="true" />
                  <Text slot="label">Upload media</Text>
                </MenuItem>
                <MenuItem id="widget" href="/widgets/new">
                  <AppsIcon aria-hidden="true" />
                  <Text slot="label">Create widget</Text>
                </MenuItem>
                <MenuItem id="data" href="/data-sources/new">
                  <DataIcon aria-hidden="true" />
                  <Text slot="label">Create data source</Text>
                </MenuItem>
              </MenuSection>
              <MenuSection aria-label="Create a presentation">
                <MenuItem id="playlist" href="/playlists?create=1">
                  <ListBulletedIcon aria-hidden="true" />
                  <Text slot="label">Create playlist</Text>
                </MenuItem>
                <MenuItem id="layout" href="/layouts?create=1">
                  <LayersIcon aria-hidden="true" />
                  <Text slot="label">Create layout</Text>
                </MenuItem>
                <MenuItem id="schedule" href="/schedules/new">
                  <CalendarIcon aria-hidden="true" />
                  <Text slot="label">Create schedule</Text>
                </MenuItem>
              </MenuSection>
            </Menu>
          </MenuTrigger>
        )}
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onUpload={() => setUploadOpen(true)}
        routes={routes}
        screens={screens.data?.items ?? []}
        canCreate={canCreate}
        canPair={canPair}
      />
      {uploadOpen && (
        <UploadContentDialog
          csrf={csrfToken}
          closeLabel="Done"
          onCreated={() => {
            void queryClient.invalidateQueries({ queryKey: ["assets"] });
          }}
          onClose={() => setUploadOpen(false)}
        />
      )}
    </header>
  );
}
