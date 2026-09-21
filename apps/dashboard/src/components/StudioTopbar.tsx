import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  Fragment,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
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
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Breadcrumb as ShadcnBreadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/vega-popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

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
    <ShadcnBreadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <Fragment key={`${item.to}:${item.label}`}>
              {index > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem className="min-w-0">
                {current ? (
                  <BreadcrumbPage className="max-w-64 truncate">
                    {item.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link to={item.to} />}>
                    {item.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </ShadcnBreadcrumb>
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
    <CommandDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      title="Search Tilecast"
      description="Search screens, content, presentations, and Studio actions."
      className="max-w-2xl"
    >
      <Command label="Search Tilecast" loop shouldFilter={false}>
        <CommandInput
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Search screens, media, playlists…"
          aria-label="Search Tilecast"
        />
        <CommandList className="max-h-[min(28rem,60vh)]">
          <CommandEmpty>
            {query.trim()
              ? `No results for “${query.trim()}”.`
              : "No destinations available."}
          </CommandEmpty>
          {groups.map((group) => (
            <CommandGroup heading={group.name} key={group.name}>
              {group.results.map((result) => (
                <CommandItem
                  key={result.id}
                  value={result.id}
                  onSelect={() => select(result)}
                >
                  <result.Icon size={16} aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{result.label}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {result.description}
                    </span>
                  </span>
                  <ChevronRight
                    className="ml-auto size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        <div className="flex items-center justify-end gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
          <span>↑↓ Move</span>
          <span>Enter Open</span>
          <span>Esc Close</span>
        </div>
      </Command>
    </CommandDialog>
  );
}

export function StudioTopbar({
  leading,
  user,
  csrfToken = "",
}: {
  leading?: ReactNode;
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
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
      <div className="flex min-w-0 items-center gap-2">
        {leading}
        <Separator orientation="vertical" className="mr-1 h-4" />
        {/* A single crumb is just the page title repeated above the page's own <h1>,
            so the trail only appears once it actually describes a path. */}
        {breadcrumbs.length > 1 && <BreadcrumbTrail items={breadcrumbs} />}
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="hidden w-72 justify-start text-muted-foreground lg:inline-flex"
          aria-label="Search Tilecast"
          aria-haspopup="dialog"
          onClick={() => setPaletteOpen(true)}
        >
          <Search aria-hidden="true" />
          <span className="truncate">Search Tilecast…</span>
          <kbd className="ml-auto rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {platformShortcut()}
          </kbd>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          aria-label="Search Tilecast"
          aria-haspopup="dialog"
          onClick={() => setPaletteOpen(true)}
        >
          <Search aria-hidden="true" />
        </Button>

        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="relative"
                aria-label="Notifications"
              />
            }
          >
            <Bell aria-hidden="true" />
            {notifications.count > 0 && (
              <span
                className={cn(
                  "topbar__notification-badge absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-4 text-white",
                  notifications.topPriority === "critical" &&
                    "topbar__notification-badge--critical bg-destructive",
                  notifications.topPriority === "warning" &&
                    "topbar__notification-badge--warning bg-amber-600",
                  notifications.topPriority === "info" &&
                    "topbar__notification-badge--info bg-blue-600",
                )}
                aria-hidden="true"
              >
                {notifications.count > 99 ? "99+" : notifications.count}
              </span>
            )}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-88 p-0">
            <PopoverTitle className="sr-only">Notifications</PopoverTitle>
            <div className="flex items-center justify-between border-b px-4 py-3">
              <span className="text-sm font-medium">Notifications</span>
              <span className="text-xs text-muted-foreground">
                {notifications.count || "No"} active
              </span>
            </div>
            {notifications.count === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                You&rsquo;re all caught up.
              </p>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                {notificationGroups.map((group) => {
                  const groupItems = notifications.items.filter(
                    (item) => item.priority === group.priority,
                  );
                  if (groupItems.length === 0) return null;
                  return (
                    <div
                      className="border-b last:border-b-0"
                      key={group.priority}
                    >
                      <div
                        className="flex items-center justify-between bg-muted/50 px-4 py-2 text-xs font-medium text-muted-foreground"
                        id={`topbar-alert-group-${group.priority}`}
                      >
                        <span>{group.label}</span>
                        <span>{groupItems.length}</span>
                      </div>
                      <ul
                        aria-labelledby={`topbar-alert-group-${group.priority}`}
                      >
                        {groupItems.map((item) => (
                          <li key={item.id}>
                            <Link
                              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-sm hover:bg-muted"
                              to={item.to}
                            >
                              <span
                                className={cn(
                                  "size-2 rounded-full bg-muted-foreground",
                                  item.priority === "critical" &&
                                    "bg-destructive",
                                  item.priority === "warning" && "bg-amber-600",
                                  item.priority === "info" && "bg-blue-600",
                                )}
                                aria-hidden="true"
                              />
                              <span className="grid min-w-0 gap-0.5">
                                <strong className="truncate font-medium">
                                  {item.title}
                                </strong>
                                <small className="truncate text-xs text-muted-foreground">
                                  {item.detail}
                                </small>
                              </span>
                              <ChevronRight
                                className="size-4 text-muted-foreground"
                                aria-hidden="true"
                              />
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
          </PopoverContent>
        </Popover>

        {canPair && (
          <Link
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "hidden sm:inline-flex",
            )}
            to="/screens/pair"
            aria-label="Pair screen"
          >
            <MonitorCheck aria-hidden="true" />
            <span className="hidden xl:inline">Pair screen</span>
          </Link>
        )}

        {canCreate && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" />}>
              <Plus aria-hidden="true" />
              <span className="hidden sm:inline">Create</span>
              <ChevronDown aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Create</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setUploadOpen(true)}>
                <Upload aria-hidden="true" />
                Upload media
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem render={<Link to="/widgets/new" />}>
                <Blocks aria-hidden="true" />
                Create widget
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/data-sources/new" />}>
                <Database aria-hidden="true" />
                Create data source
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/playlists?create=1" />}>
                <ListVideo aria-hidden="true" />
                Create playlist
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/layouts?create=1" />}>
                <Layers3 aria-hidden="true" />
                Create layout
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/schedules/new" />}>
                <CalendarClock aria-hidden="true" />
                Create schedule
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
