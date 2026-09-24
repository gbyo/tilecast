import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  ChevronRight,
  FileSliders,
  Image,
  Layers3,
  ListVideo,
  Monitor,
  MonitorCheck,
  Puzzle,
  Settings,
  Upload,
  UserRound,
} from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";
import {
  matchRoutes,
  useLocation,
  useNavigate,
  type RouteObject,
} from "react-router";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../api/client";
import type { PluginSummary, Screen, ScreenStatus, User } from "../api/types";
import { hasStudioRoute, pluginsQueryKey } from "../plugins/pluginCatalog";
import { useNotifications } from "../notifications/useNotifications";
import {
  studioRouteHandle,
  useStudioRoutes,
  type BreadcrumbResource,
} from "../navigation/studioRoutes";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Kbd } from "./ui/kbd";
import { SiteHeader } from "./studio/SiteHeader";
import { MediaUploadDialog } from "./content-picker/MediaUploadDialog";

// Command categories are translation keys into palette.groups. Display names
// are resolved with t() at render in groupCommandResults.
type CommandGroupName =
  | "quickActions"
  | "screens"
  | "content"
  | "presentations"
  | "scheduling"
  | "administration"
  | "navigation";

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

const statusLabelKeys: Record<
  ScreenStatus,
  | "palette.screenStatus.online"
  | "palette.screenStatus.recent"
  | "palette.screenStatus.stale"
  | "palette.screenStatus.offline"
  | "palette.screenStatus.disabled"
  | "palette.screenStatus.revoked"
> = {
  online: "palette.screenStatus.online",
  recent: "palette.screenStatus.recent",
  stale: "palette.screenStatus.stale",
  offline: "palette.screenStatus.offline",
  disabled: "palette.screenStatus.disabled",
  revoked: "palette.screenStatus.revoked",
};

const commandGroupOrder: CommandGroupName[] = [
  "quickActions",
  "screens",
  "content",
  "presentations",
  "scheduling",
  "administration",
  "navigation",
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
  if (to.startsWith("/screens") || to.startsWith("/groups")) return "screens";
  if (
    to.startsWith("/assets") ||
    to.startsWith("/widgets") ||
    to.startsWith("/data-sources")
  )
    return "content";
  if (to.startsWith("/playlists") || to.startsWith("/layouts"))
    return "presentations";
  if (to.startsWith("/schedules")) return "scheduling";
  if (
    to.startsWith("/settings") ||
    to.startsWith("/preferences") ||
    to.startsWith("/account") ||
    to.startsWith("/approvals") ||
    to.startsWith("/activity")
  )
    return "administration";
  return "navigation";
}

function collectRouteResults(routes: readonly RouteObject[], t: NavigationT) {
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
        description: item.descriptionKey
          ? t(item.descriptionKey, item.descriptionValues)
          : item.description,
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

type NavigationT = TFunction<"navigation", undefined>;

// Search aliases stay in English in every language: they are matching tokens,
// not displayed text, and the locale files hold strings only.
// i18n-ignore: command-palette search aliases below
const actionKeywords = {
  pairScreen: ["add screen", "new device", "player"],
  uploadMedia: ["content", "asset", "file"],
  createPlaylist: ["new presentation"],
  createLayout: ["new presentation", "canvas"],
  createSchedule: ["new deployment", "publish"],
} as const;

function collectActionResults(t: NavigationT, permissions: CommandPermissions) {
  const results: (Omit<CommandResult, "score"> & { keywords?: string[] })[] =
    [];
  if (permissions.canPair) {
    results.push({
      id: "action:pair-screen",
      label: t("palette.actions.pairScreen.label"),
      description: t("palette.actions.pairScreen.description"),
      to: "/screens/pair",
      category: "quickActions",
      Icon: MonitorCheck,
      keywords: [...actionKeywords.pairScreen],
    });
  }
  if (permissions.canCreate) {
    results.push(
      {
        id: "action:upload-media",
        label: t("palette.actions.uploadMedia.label"),
        description: t("palette.actions.uploadMedia.description"),
        action: "upload-media",
        category: "quickActions",
        Icon: Upload,
        keywords: [...actionKeywords.uploadMedia],
      },
      {
        id: "action:create-playlist",
        label: t("palette.actions.createPlaylist.label"),
        description: t("palette.actions.createPlaylist.description"),
        to: "/playlists?create=1",
        category: "quickActions",
        Icon: ListVideo,
        keywords: [...actionKeywords.createPlaylist],
      },
      {
        id: "action:create-layout",
        label: t("palette.actions.createLayout.label"),
        description: t("palette.actions.createLayout.description"),
        to: "/layouts?create=1",
        category: "quickActions",
        Icon: Layers3,
        keywords: [...actionKeywords.createLayout],
      },
      {
        id: "action:create-schedule",
        label: t("palette.actions.createSchedule.label"),
        description: t("palette.actions.createSchedule.description"),
        to: "/schedules/new",
        category: "quickActions",
        Icon: CalendarClock,
        keywords: [...actionKeywords.createSchedule],
      },
    );
  }
  return results;
}

/**
 * Plugins come from the server catalog rather than static routes. An installed
 * plugin is an ordinary destination; an uninstalled one is offered as a
 * discovery result that opens Add plugin on it, never as its management page.
 */
function collectPluginResults(t: NavigationT, plugins: PluginSummary[]) {
  return plugins.map((plugin) => ({
    id: `plugin:${plugin.id}`,
    label: plugin.name,
    description: plugin.installed
      ? t("palette.plugin")
      : t("palette.pluginNotInstalled"),
    to:
      plugin.installed && hasStudioRoute(plugin.managementPath)
        ? plugin.managementPath
        : plugin.installed
          ? "/plugins"
          : `/plugins?add=${encodeURIComponent(plugin.id)}`,
    category: "navigation" as const,
    Icon: Puzzle,
    keywords: [plugin.category, plugin.description, ...plugin.capabilities],
  }));
}

export function buildCommandResults(
  routes: readonly RouteObject[],
  screens: Screen[],
  query: string,
  permissions: CommandPermissions = { canCreate: true, canPair: true },
  plugins: PluginSummary[] = [],
  t: NavigationT,
) {
  const providers: CommandProvider[] = [
    { id: "actions", results: () => collectActionResults(t, permissions) },
    { id: "routes", results: () => collectRouteResults(routes, t) },
    { id: "plugins", results: () => collectPluginResults(t, plugins) },
    {
      id: "screens",
      results: () =>
        screens.map((screen) => ({
          id: `screen:${screen.id}`,
          label: screen.name,
          description: `${t(statusLabelKeys[screen.status])}${screen.location ? ` · ${screen.location}` : ""}`,
          to: `/screens/${screen.id}`,
          category: "screens" as const,
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
        result.category === "quickActions" || defaultRouteIds.has(result.id),
    );
  }

  return results.slice(0, 20);
}

function groupCommandResults(t: NavigationT, results: CommandResult[]) {
  return commandGroupOrder
    .map((name) => ({
      name: t(`palette.groups.${name}` as const),
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
    case "campaign":
      return ["campaign", id] as const;
    case "schedule":
      return ["schedules", id] as const;
    case "form":
      return ["form-data-source", id] as const;
    case "countdown-bar":
      return ["countdown-bar", id] as const;
    case "brand-bug":
      return ["brand-bug", id] as const;
    case "noise-meter":
      return ["noise-meter", id] as const;
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
    case "campaign":
      return api.campaign(id);
    case "schedule":
      return api.schedule(id);
    case "form":
      return api.getForm(id);
    case "countdown-bar":
      return api.countdownBar(id);
    case "brand-bug":
      return api.brandBug(id);
    case "noise-meter":
      return api.noiseMeter(id);
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

function isModalTextInput(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.matches(
      'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]',
    ) || target.isContentEditable
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
  const { t } = useTranslation(["navigation", "common"]);
  const [query, setQuery] = useState("");
  // Read only while searching; the catalog is shared with the Plugins page.
  const plugins = useQuery({
    queryKey: pluginsQueryKey,
    queryFn: api.plugins,
    enabled: open,
  });
  const results = buildCommandResults(
    routes,
    screens,
    query,
    { canCreate, canPair },
    plugins.data?.items ?? [],
    t,
  );
  const groups = groupCommandResults(t, results);

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
      title={t("palette.title")}
      description={t("palette.description")}
      className="w-[min(42rem,calc(100vw-2rem))]"
    >
      <Command
        className="min-h-72 p-1"
        label={t("palette.label")}
        loop
        shouldFilter={false}
      >
        <CommandInput
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={t("palette.placeholder")}
          aria-label={t("palette.label")}
        />
        <CommandList
          label={t("palette.resultsLabel")}
          className="max-h-[min(65vh,28rem)]"
        >
          <CommandEmpty>
            {query.trim()
              ? t("palette.noResults", { query: query.trim() })
              : t("palette.noDestinations")}
          </CommandEmpty>
          {groups.map((group) => (
            <CommandGroup heading={group.name} key={group.name}>
              {group.results.map((result) => (
                <CommandItem
                  key={result.id}
                  value={result.id}
                  onSelect={() => select(result)}
                  className="min-h-11"
                >
                  <result.Icon aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {result.label}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {result.description}
                    </span>
                  </span>
                  <ChevronRight aria-hidden="true" />
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        <div className="flex items-center gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
          <span>
            {/* i18n-ignore: arrow-key glyphs, not language text */}
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t("palette.hints.move")}
          </span>
          <span>
            {/* i18n-ignore: key name, not language text */}
            <Kbd>Enter</Kbd> {t("palette.hints.open")}
          </span>
          <span>
            {/* i18n-ignore: key name, not language text */}
            <Kbd>Esc</Kbd> {t("palette.hints.close")}
          </span>
          {/* i18n-ignore: keyboard shortcut glyphs, not language text */}
          <span className="ml-auto">{platformShortcut()}</span>
        </div>
      </Command>
    </CommandDialog>
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
    <>
      <SiteHeader
        breadcrumbs={breadcrumbs}
        notifications={notifications}
        onSearch={() => setPaletteOpen(true)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onUpload={() => setUploadOpen(true)}
        routes={routes}
        screens={screens.data?.items ?? []}
        canCreate={canCreate}
        canPair={canPair}
      />
      <MediaUploadDialog
        open={uploadOpen}
        csrf={csrfToken}
        onAsset={() => {
          void queryClient.invalidateQueries({ queryKey: ["assets"] });
        }}
        onClose={() => setUploadOpen(false)}
      />
    </>
  );
}
