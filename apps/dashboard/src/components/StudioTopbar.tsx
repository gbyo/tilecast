import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Command } from "cmdk";
import {
  Bell,
  Blocks,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Database,
  FileSliders,
  Image,
  Layers3,
  ListVideo,
  Monitor,
  MonitorCheck,
  Plus,
  Search,
  Settings,
  Upload,
  UserRound,
} from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";
import {
  Link,
  matchRoutes,
  useLocation,
  useNavigate,
  type RouteObject,
} from "react-router";
import { api } from "../api/client";
import type { Screen, ScreenStatus, User } from "../api/types";
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
import { Button, Dialog, IconButton, Popover } from "./ui";

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
  Icon: ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" }>;
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

function resultIcon(to: string) {
  if (to.startsWith("/screens") || to.startsWith("/groups")) return Monitor;
  if (to.startsWith("/assets")) return Image;
  if (to.startsWith("/playlists")) return ListVideo;
  if (to.startsWith("/layouts")) return Layers3;
  if (to.startsWith("/schedules")) return CalendarClock;
  if (
    to.startsWith("/settings") ||
    to.startsWith("/preferences") ||
    to.startsWith("/account")
  )
    return to.startsWith("/account") ? UserRound : Settings;
  return FileSliders;
}

function routeGroup(to: string): CommandGroupName {
  if (to.startsWith("/screens") || to.startsWith("/groups")) return "Screens";
  if (
    to.startsWith("/assets") ||
    to.startsWith("/widgets") ||
    to.startsWith("/data-sources")
  )
    return "Content";
  if (to.startsWith("/playlists") || to.startsWith("/layouts"))
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
        Icon: resultIcon(item.to),
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
      Icon: MonitorCheck,
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
        Icon: Upload,
        keywords: ["content", "asset", "file"],
      },
      {
        id: "action:create-playlist",
        label: "Create playlist",
        description: "Build a new fullscreen presentation",
        to: "/playlists?create=1",
        category: "Quick actions",
        Icon: ListVideo,
        keywords: ["new presentation"],
      },
      {
        id: "action:create-layout",
        label: "Create layout",
        description: "Arrange content on a presentation canvas",
        to: "/layouts?create=1",
        category: "Quick actions",
        Icon: Layers3,
        keywords: ["new presentation", "canvas"],
      },
      {
        id: "action:create-schedule",
        label: "Create schedule",
        description: "Plan where and when content plays",
        to: "/schedules/new",
        category: "Quick actions",
        Icon: CalendarClock,
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
          Icon: Monitor,
          keywords: [
            screen.location,
            screen.platform,
            "screen",
            "player",
          ].filter(Boolean),
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

// These query keys are shared with each resource's detail page, so the cached value
// must be the full entity (never a derived string) or the page and the breadcrumb
// would overwrite each other's cache entry with incompatible shapes.
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
    <nav className="topbar__breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <li key={`${item.to}:${item.label}`}>
              {index > 0 && (
                <span className="topbar__breadcrumb-separator" aria-hidden>
                  /
                </span>
              )}
              {current ? (
                <span aria-current="page">{item.label}</span>
              ) : (
                <Link to={item.to}>{item.label}</Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function isModalTextInput(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const textInput =
    target.matches(
      'input:not([type="button"]):not([type="submit"]), textarea',
    ) || target.isContentEditable;
  return (
    textInput &&
    Boolean(target.closest('dialog, [role="dialog"], .modal, .drawer'))
  );
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

  return (
    <Dialog
      open={open}
      title="Search Tilecast"
      className="command-palette-dialog"
      onClose={onClose}
    >
      <Command
        className="command-palette"
        label="Search Tilecast"
        loop
        shouldFilter={false}
      >
        <label className="command-palette__input">
          <Search size={18} aria-hidden="true" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search screens, media, playlists…"
            aria-label="Search Tilecast"
          />
          <kbd>{platformShortcut()}</kbd>
        </label>
        <Command.List
          className="command-palette__results"
          label="Search results"
        >
          <Command.Empty className="command-palette__empty">
            {query.trim()
              ? `No results for “${query.trim()}”.`
              : "No destinations available."}
          </Command.Empty>
          {groups.map((group) => (
            <Command.Group
              className="command-palette__group"
              heading={group.name}
              key={group.name}
            >
              {group.results.map((result) => (
                <Command.Item
                  className="command-palette__result"
                  key={result.id}
                  value={result.id}
                  onSelect={() => select(result)}
                >
                  <result.Icon size={18} aria-hidden="true" />
                  <span>
                    <strong>{result.label}</strong>
                    <small>{result.description}</small>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
        <footer className="command-palette__footer">
          <span>↑↓ Move</span>
          <span>Enter Open</span>
          <span>Esc Close</span>
        </footer>
      </Command>
    </Dialog>
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
  const notifications = useNotifications(user);
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

  // Popover dismisses itself on Escape, an outside press, and a route change.
  useEffect(() => {
    setPaletteOpen(false);
  }, [location.pathname]);

  return (
    <header className="topbar">
      <div className="topbar__left">
        {/* A single crumb is just the page title repeated above the page's own <h1>,
            so the trail only appears once it actually describes a path. */}
        {breadcrumbs.length > 1 && <BreadcrumbTrail items={breadcrumbs} />}
      </div>
      <button
        className="topbar__search"
        type="button"
        aria-label="Search Tilecast"
        aria-haspopup="dialog"
        onClick={() => setPaletteOpen(true)}
      >
        <Search size={17} aria-hidden="true" />
        {/* Deliberately not "Search screens…": pages carry their own list filter,
            and two controls promising to search screens read as competitors. */}
        <span className="topbar__search-placeholder">Search Tilecast…</span>
        <kbd>{platformShortcut()}</kbd>
      </button>
      <div className="topbar__utilities">
        {/* Not a menu: the panel carries a heading, a count, and labelled
            groups, none of which an ARIA menu may contain — a screen reader
            drops them and announces a bare item count. It is a labelled surface
            holding grouped lists of links. */}
        <Popover
          label="Notifications"
          className="topbar__notifications"
          panelClassName="topbar__alerts"
          width="22rem"
          align="end"
          trigger={(props) => (
            <IconButton label="Notifications" {...props}>
              <Bell size={18} aria-hidden="true" />
              {notifications.count > 0 && (
                <span
                  className={`topbar__notification-badge topbar__notification-badge--${notifications.topPriority}`}
                  aria-hidden="true"
                >
                  {notifications.count > 99 ? "99+" : notifications.count}
                </span>
              )}
            </IconButton>
          )}
        >
          <header>
            <strong>Notifications</strong>
            <span>{notifications.count || "No"} active</span>
          </header>
          {notifications.count === 0 ? (
            <p>You&rsquo;re all caught up.</p>
          ) : (
            <div className="topbar__alert-groups">
              {notificationGroups.map((group) => {
                const groupItems = notifications.items.filter(
                  (item) => item.priority === group.priority,
                );
                if (groupItems.length === 0) return null;
                return (
                  <div className="topbar__alert-group" key={group.priority}>
                    <p
                      className="topbar__alert-group-label"
                      id={`topbar-alert-group-${group.priority}`}
                    >
                      {group.label}
                      <span>{groupItems.length}</span>
                    </p>
                    <ul
                      className="topbar__alert-list"
                      aria-labelledby={`topbar-alert-group-${group.priority}`}
                    >
                      {groupItems.map((item) => (
                        <li key={item.id}>
                          <Link to={item.to}>
                            <span
                              className={`topbar__alert-marker topbar__alert-marker--${item.priority}`}
                              aria-hidden
                            />
                            <span>
                              <strong>{item.title}</strong>
                              <small>{item.detail}</small>
                            </span>
                            <ChevronRight size={15} aria-hidden="true" />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </Popover>
        <span className="topbar__divider" aria-hidden="true" />
        {canPair && (
          <Link
            className="button button--secondary topbar__pair"
            to="/screens/pair"
            aria-label="Pair screen"
          >
            <MonitorCheck size={16} aria-hidden="true" />
            <span>Pair screen</span>
          </Link>
        )}
        {canCreate && (
          <Popover
            label="Create"
            mode="menu"
            className="topbar__create"
            panelClassName="topbar__create-menu"
            align="end"
            trigger={(props) => (
              <Button variant="primary" {...props}>
                <Plus size={16} aria-hidden="true" /> Create
                <ChevronDown size={15} aria-hidden="true" />
              </Button>
            )}
          >
            {(close) => (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    setUploadOpen(true);
                  }}
                >
                  <Upload size={16} aria-hidden="true" /> Upload media
                </button>
                <Link role="menuitem" to="/widgets/new" onClick={close}>
                  <Blocks size={16} aria-hidden="true" /> Create widget
                </Link>
                <Link role="menuitem" to="/data-sources/new" onClick={close}>
                  <Database size={16} aria-hidden="true" /> Create data source
                </Link>
                <Link role="menuitem" to="/playlists?create=1" onClick={close}>
                  <ListVideo size={16} aria-hidden="true" /> Create playlist
                </Link>
                <Link role="menuitem" to="/layouts?create=1" onClick={close}>
                  <Layers3 size={16} aria-hidden="true" /> Create layout
                </Link>
                <Link role="menuitem" to="/schedules/new" onClick={close}>
                  <CalendarClock size={16} aria-hidden="true" /> Create schedule
                </Link>
              </>
            )}
          </Popover>
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
