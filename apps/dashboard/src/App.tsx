import { Navigate, useRoutes, type RouteObject } from "react-router";
import { Toaster } from "./components/ui/toast";
import { GitHubOAuthSetupPortal } from "./components/GitHubOAuthSetupPortal";
import { StudioRoutesProvider } from "./navigation/studioRoutes";
import type { StudioNavigationMetadata } from "./navigation/studioNavigation";
import { NativeHostProvider } from "./native-host/NativeHostProvider";
import { NativeAuthLifecycle } from "./native-host/useNativeAuthLifecycle";
import { PRESENTATION_ROOT } from "./native-host/protocol";
import { NativePresentationHost } from "./native-presentation/NativePresentationHost";
import { NativeMediaIntakeRefresh } from "./native-host/NativeMediaIntakeRefresh";
import { NativePresentationNavigation } from "./native-presentation/NativePresentationNavigation";
import { LiveStreamPresentation } from "./components/LiveStreamPresentation";
import { settingsItems } from "./settings/settingsNavigation";
import { AuthPage } from "./pages/AuthPage";
import { DashboardShell, FoundationPage } from "./pages/Dashboard";
import {
  ScreensPairRoute,
  ScreensPage,
  ScreensWorkspacePage,
} from "./pages/ScreensPage";
import { FleetBulkPage } from "./pages/FleetBulkPage";
import { ContentReviewPage } from "./pages/ContentReviewPage";
import { ContentSubmissionInboxPage } from "./pages/ContentSubmissionInboxPage";
import { ScreenDetailWithPreviewPage } from "./pages/ScreenDetailWithPreviewPage";
import { ArchivedScreensPage } from "./pages/ArchivedScreensPage";
import { ContentPage } from "./pages/ContentPage";
import { PlaylistEditorPage } from "./components/playlist-editor/PlaylistEditor";
import { PlaylistLibraryPage } from "./pages/PlaylistLibraryPage";
import { ActivityIncidentPresentation } from "./pages/ActivityIncidentPresentation";
import { PairScreenPresentation } from "./pairing/PairScreenPresentation";
import { UpdateDeploymentPresentation } from "./settings/UpdateDeploymentPresentation";
import { MediaAssetPresentation } from "./pages/MediaAssetPresentation";
import { PlaylistPreviewPage } from "./pages/PlaylistPreviewPage";
import {
  GroupsPage,
  GroupDetailPage,
  SchedulesPage,
  ScheduleEditorPage,
} from "./pages/SchedulesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { OAuthApprovalPage } from "./pages/OAuthApprovalPage";
import { MyAccountPage } from "./pages/MyAccountPage";
import { LayoutsPage } from "./pages/LayoutsPage";
import { LayoutEditorPage } from "./pages/LayoutEditorPage";
import { LayoutPreviewPage } from "./pages/LayoutPreviewPage";
import { WidgetEditorPage, WidgetsPage } from "./pages/WidgetsPage";
import { DataSourceEditorPage, DataSourcesPage } from "./pages/DataSourcesPage";
import { ActivityPage } from "./pages/ActivityPage";
import { PluginsPage } from "./pages/PluginsPage";
import {
  assertStudioRouteCollisions,
  pluginRouteObjects,
  pluginStandaloneRouteObjects,
} from "./plugin-host/routes";
import { CampaignsPage } from "./pages/CampaignsPage";

const search = (
  label: string,
  description: string,
  to: string,
  keywords?: string[],
) => ({ label, description, to, keywords });

// Navigation destinations are route metadata: the browser sidebar and native
// hosts both render them, and a destination leads to its route's own path.
const destination = (metadata: StudioNavigationMetadata) => metadata;

const settingsSearch: Partial<
  Record<
    string,
    {
      descriptionKey: "palette.settingsSearch.dependencyGraph";
      keywords: string[];
    }
  >
> = {
  "dependency-graph": {
    descriptionKey: "palette.settingsSearch.dependencyGraph",
    // Search aliases stay in English in every language: they are matching
    // tokens, not displayed text, and the locale files hold strings only.
    keywords: [
      "dependency graph",
      "content map",
      "used by",
      "relationships",
      "impact",
      "system tools",
    ],
  },
};

/**
 * Routes a native host can present in its own sheet, below the reserved
 * /__native/modal root. Adding one needs no app change: the host knows only
 * the root. They have no navigation or search metadata, and outside a
 * native presentation page the root redirects to the start page.
 */
const presentationRoutes: RouteObject[] = [
  { path: "pair-screen", element: <PairScreenPresentation /> },
  { path: "pair-screen/:requestId", element: <PairScreenPresentation /> },
  { path: "live-stream/:screenId", element: <LiveStreamPresentation /> },
  { path: "layout-preview/:id", element: <LayoutPreviewPage /> },
  { path: "playlist-preview/:id", element: <PlaylistPreviewPage /> },
  { path: "asset/:id", element: <MediaAssetPresentation /> },
  {
    path: "update-deployment/:id",
    element: <UpdateDeploymentPresentation />,
  },
  {
    path: "activity-incident/:id",
    element: <ActivityIncidentPresentation />,
  },
];

export const studioRoutes: RouteObject[] = [
  {
    path: PRESENTATION_ROOT,
    element: <NativePresentationHost routes={presentationRoutes} />,
    children: presentationRoutes,
  },
  { path: "/setup", element: <AuthPage mode="setup" /> },
  { path: "/login", element: <AuthPage mode="login" /> },
  { path: "/playlists/:id/preview", element: <PlaylistPreviewPage /> },
  { path: "/layouts/:id/preview", element: <LayoutPreviewPage /> },
  {
    path: "/",
    element: <DashboardShell />,
    children: [
      {
        index: true,
        element: <FoundationPage />,
        handle: {
          navigation: destination({
            id: "overview",
            group: "home",
            labelKey: "overview",
            icon: "home",
            order: 0,
            mobilePlacement: "primary",
            end: true,
          }),
          breadcrumb: "Overview",
          search: search(
            "Overview",
            "Installation health and current player status",
            "/",
            ["dashboard", "home"],
          ),
        },
      },
      {
        path: "screens",
        handle: {
          navigation: destination({
            id: "screens",
            group: "screens",
            labelKey: "items.fleet",
            icon: "screens",
            order: 10,
            mobilePlacement: "primary",
            // The archive has its own page and no sidebar entry.
            excludeActiveOn: ["/screens/archive"],
          }),
          breadcrumb: "Screens",
          search: search(
            "Screens",
            "Pair and monitor signage players",
            "/screens",
            ["players", "devices", "fleet"],
          ),
        },
        children: [
          {
            element: <ScreensWorkspacePage />,
            children: [
              { index: true, element: <ScreensPage /> },
              {
                path: "archive",
                element: <ArchivedScreensPage />,
                handle: {
                  breadcrumb: "Archive",
                  search: search(
                    "Screen archive",
                    "Review players whose pairings were revoked",
                    "/screens/archive",
                    ["revoked", "archived", "players", "devices"],
                  ),
                },
              },
              {
                path: "pair",
                element: <ScreensPairRoute />,
                handle: { breadcrumb: "Pair screen" },
              },
              {
                path: "pair/:code",
                element: <ScreensPairRoute />,
                handle: { breadcrumb: "Pair screen" },
              },
              {
                path: "pair/request/:requestId",
                element: <ScreensPairRoute />,
                handle: { breadcrumb: "Pair screen" },
              },
            ],
          },
          {
            path: "bulk",
            element: <FleetBulkPage />,
            handle: {
              breadcrumb: "Bulk changes",
              searchAllowedRoles: ["owner", "administrator"],
              search: search(
                "Bulk changes",
                "Apply one change to many screens with a preview",
                "/screens/bulk",
                ["fleet", "bulk", "assign"],
              ),
            },
          },
          {
            path: ":id",
            element: <ScreenDetailWithPreviewPage />,
            handle: { breadcrumb: "Screen", resource: "screen" },
          },
        ],
      },
      {
        path: "groups",
        handle: {
          navigation: destination({
            id: "groups",
            group: "screens",
            labelKey: "items.displayGroups",
            icon: "groups",
            order: 20,
          }),
          breadcrumb: "Display Groups",
          search: search(
            "Display Groups",
            "Keep multiple screens playing in lockstep",
            "/groups",
            ["screen groups", "synchronized playback", "mirror", "span"],
          ),
        },
        children: [
          { index: true, element: <GroupsPage /> },
          {
            path: ":id",
            element: <GroupDetailPage />,
            handle: { breadcrumb: "Display Group", resource: "screen-group" },
          },
        ],
      },
      {
        path: "assets",
        element: <ContentPage />,
        handle: {
          navigation: destination({
            id: "media",
            group: "content",
            labelKey: "items.media",
            icon: "media",
            order: 10,
            mobilePlacement: "primary",
          }),
          breadcrumb: "Media",
          search: search(
            "Content: Media",
            "Browse uploaded images, videos, and website content",
            "/assets",
            ["content", "uploads", "library", "media"],
          ),
        },
      },
      { path: "content", element: <Navigate to="/assets" replace /> },
      {
        path: "presentations",
        element: <Navigate to="/playlists" replace />,
      },
      {
        path: "widgets",
        handle: {
          navigation: destination({
            id: "widgets",
            group: "content",
            labelKey: "items.widgets",
            icon: "widgets",
            order: 20,
          }),
          breadcrumb: "Widgets",
          search: search(
            "Content: Widgets",
            "Manage reusable dynamic signage content",
            "/widgets",
            ["content"],
          ),
        },
        children: [
          { index: true, element: <WidgetsPage /> },
          {
            path: "new",
            element: <WidgetEditorPage />,
            handle: { breadcrumb: "Create widget" },
          },
          {
            path: "new/:provider",
            element: <WidgetEditorPage />,
            handle: { breadcrumb: "Create widget" },
          },
          {
            path: ":id",
            element: <WidgetEditorPage />,
            handle: { breadcrumb: "Widget", resource: "widget" },
          },
        ],
      },
      {
        path: "data-sources",
        handle: {
          navigation: destination({
            id: "data-sources",
            group: "content",
            labelKey: "items.dataSources",
            icon: "data",
            order: 30,
          }),
          breadcrumb: "Data Sources",
          search: search(
            "Content: Data",
            "Manage reusable data connections",
            "/data-sources",
            ["feeds", "integrations", "content", "data sources"],
          ),
        },
        children: [
          { index: true, element: <DataSourcesPage /> },
          {
            path: "new",
            element: <DataSourceEditorPage />,
            handle: { breadcrumb: "Create data source" },
          },
          {
            path: "new/:provider",
            element: <DataSourceEditorPage />,
            handle: { breadcrumb: "Create data source" },
          },
          {
            path: ":id",
            element: <DataSourceEditorPage />,
            handle: { breadcrumb: "Data source", resource: "data-source" },
          },
        ],
      },
      {
        path: "content-review",
        handle: {
          breadcrumb: "Content review",
          search: search(
            "Content review",
            "Approve content before it reaches a screen",
            "/content-review",
            ["approval", "review", "publish"],
          ),
        },
        children: [
          { index: true, element: <ContentReviewPage /> },
          {
            path: "submissions",
            element: <ContentSubmissionInboxPage />,
            handle: { breadcrumb: "Submissions" },
          },
        ],
      },
      {
        path: "playlists",
        handle: {
          navigation: destination({
            id: "playlists",
            group: "presentations",
            labelKey: "items.playlists",
            icon: "playlists",
            order: 10,
          }),
          breadcrumb: "Playlists",
          search: search(
            "Presentations: Playlists",
            "Build ordered fullscreen playback",
            "/playlists",
            ["presentations"],
          ),
        },
        children: [
          { index: true, element: <PlaylistLibraryPage /> },
          {
            path: ":id",
            element: <PlaylistEditorPage />,
            handle: { breadcrumb: "Playlist", resource: "playlist" },
          },
        ],
      },
      {
        path: "layouts",
        handle: {
          navigation: destination({
            id: "layouts",
            group: "presentations",
            labelKey: "items.layouts",
            icon: "layouts",
            order: 20,
          }),
          breadcrumb: "Layouts",
          search: search(
            "Presentations: Layouts",
            "Arrange content on a presentation canvas",
            "/layouts",
            ["presentations"],
          ),
        },
        children: [
          { index: true, element: <LayoutsPage /> },
          {
            path: ":id",
            element: <LayoutEditorPage />,
            handle: { breadcrumb: "Layout", resource: "layout" },
          },
        ],
      },
      {
        path: "campaigns",
        handle: {
          navigation: destination({
            id: "campaigns",
            group: "presentations",
            labelKey: "items.campaigns",
            icon: "campaigns",
            order: 30,
          }),
          breadcrumb: "Campaigns",
          search: search(
            "Presentations: Campaigns",
            "Coordinate reviewed releases across screens and groups",
            "/campaigns",
            ["presentations", "release", "publish", "deployment"],
          ),
        },
        children: [
          { index: true, element: <CampaignsPage /> },
          {
            path: ":id",
            element: <CampaignsPage />,
            handle: { breadcrumb: "Campaign", resource: "campaign" },
          },
        ],
      },
      {
        path: "schedules",
        handle: {
          navigation: destination({
            id: "schedules",
            group: "operations",
            labelKey: "items.schedules",
            icon: "schedules",
            order: 10,
          }),
          breadcrumb: "Schedules",
          search: search(
            "Schedules",
            "Deploy content to screens at the right time",
            "/schedules",
          ),
        },
        children: [
          { index: true, element: <SchedulesPage /> },
          {
            path: "new",
            element: <ScheduleEditorPage />,
            handle: { breadcrumb: "Create schedule" },
          },
          {
            path: ":id",
            element: <ScheduleEditorPage />,
            handle: { breadcrumb: "Schedule", resource: "schedule" },
          },
        ],
      },
      {
        path: "plugins",
        handle: {
          navigation: destination({
            id: "plugins",
            group: "operations",
            labelKey: "items.plugins",
            icon: "plugins",
            order: 20,
          }),
          breadcrumb: "Plugins",
          search: search(
            "Plugins",
            "Add and manage optional Tilecast features",
            "/plugins",
            ["add plugin", "integrations", "player features"],
          ),
        },
        children: [
          { index: true, element: <PluginsPage /> },
          // Dependency Graph is a system tool, not a plugin. The old address
          // keeps working for bookmarks for at least one release.
          {
            path: "dependency-graph",
            element: <Navigate to="/settings/dependency-graph" replace />,
          },
          // Routes contributed by plugins/*/studio, discovered at build time.
          ...pluginRouteObjects(),
        ],
      },
      { path: "users", element: <Navigate to="/settings/users" replace /> },
      // Plugin-owned routes inside the authenticated chrome, discovered at
      // build time.
      ...pluginStandaloneRouteObjects({ topLevel: false }),
      {
        path: "activity",
        element: <ActivityPage />,
        handle: {
          navigation: destination({
            id: "activity",
            group: "secondary",
            labelKey: "items.activity",
            icon: "activity",
            order: 100,
          }),
          breadcrumb: "Activity",
          search: search(
            "Activity",
            "Review recent system and playback events",
            "/activity",
            ["monitor", "events"],
          ),
        },
      },
      {
        path: "account",
        element: <MyAccountPage />,
        handle: {
          breadcrumb: "My Account",
          search: search(
            "My Account",
            "Manage your profile, preferences, and sign-in security",
            "/account",
            [
              "preferences",
              "security",
              "mfa",
              "2fa",
              "passkey",
              "authenticator",
              "recovery",
              "theme",
              "appearance",
              "density",
            ],
          ),
        },
      },
      {
        path: "oauth/approve",
        element: <OAuthApprovalPage />,
        handle: {
          breadcrumb: "Authorize access",
          search: search(
            "Authorize access",
            "Approve a loopback operator such as the Tilecast CLI",
            "/oauth/approve",
            ["oauth", "cli", "authorize", "grant", "token"],
          ),
        },
      },
      {
        path: "preferences",
        element: <Navigate to="/account#preferences" replace />,
      },
      {
        path: "security",
        element: <Navigate to="/account#security" replace />,
      },
      {
        path: "settings",
        handle: {
          navigation: destination({
            id: "settings",
            group: "secondary",
            labelKey: "items.settings",
            icon: "settings",
            order: 900,
          }),
          breadcrumb: "Settings",
          search: search(
            "Settings",
            "Configure this Tilecast installation",
            "/settings/general",
          ),
        },
        children: [
          {
            index: true,
            element: <Navigate to="/settings/general" replace />,
          },
          ...settingsItems.map((item) => {
            const entry = settingsSearch[item.id];
            return {
              path: item.path,
              element: <SettingsPage />,
              handle: {
                breadcrumb: item.label,
                search: {
                  ...search(
                    item.label,
                    `${item.label} settings`,
                    `/settings/${item.path}`,
                    ["settings", ...(entry?.keywords ?? [])],
                  ),
                  descriptionKey:
                    entry?.descriptionKey ??
                    "palette.settingsSearch.sectionFallback",
                  descriptionValues: entry ? undefined : { label: item.label },
                },
              },
            };
          }),
          {
            path: "preferences",
            element: <Navigate to="/account#preferences" replace />,
          },
          {
            path: "*",
            element: <Navigate to="/settings/general" replace />,
          },
        ],
      },
    ],
  },
  // Plugin-owned top-level routes with their own shell, discovered at
  // build time.
  ...pluginStandaloneRouteObjects({ topLevel: true }),
  { path: "*", element: <Navigate to="/" replace /> },
];

// A plugin must never shadow a core Studio route. The check runs on the
// composed tree, so it covers standalone and management routes wherever
// they mount; a collision fails the shell loudly instead of silently
// overriding Studio.
assertStudioRouteCollisions(studioRoutes);

function RoutedApp() {
  return useRoutes(studioRoutes);
}

export function App() {
  return (
    <NativeHostProvider>
      <NativeAuthLifecycle />
      <NativePresentationNavigation />
      <NativeMediaIntakeRefresh />
      <GitHubOAuthSetupPortal />
      <StudioRoutesProvider routes={studioRoutes}>
        <RoutedApp />
      </StudioRoutesProvider>
      <Toaster />
    </NativeHostProvider>
  );
}
