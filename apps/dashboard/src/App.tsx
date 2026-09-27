import { Navigate, useRoutes, type RouteObject } from "react-router";
import { Toaster } from "./components/ui/toast";
import { GitHubOAuthSetupPortal } from "./components/GitHubOAuthSetupPortal";
import { StudioRoutesProvider } from "./navigation/studioRoutes";
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
import { PlaylistEditorPage } from "./pages/PlaylistsPage";
import { PlaylistLibraryPage } from "./pages/PlaylistLibraryPage";
import { PlaylistPreviewPage } from "./pages/PlaylistPreviewPage";
import {
  GroupsPage,
  GroupDetailPage,
  SchedulesPage,
  ScheduleEditorPage,
} from "./pages/SchedulesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { MyAccountPage } from "./pages/MyAccountPage";
import { LayoutsPage } from "./pages/LayoutsPage";
import { LayoutEditorPage } from "./pages/LayoutEditorPage";
import { WidgetEditorPage, WidgetsPage } from "./pages/WidgetsPage";
import { DataSourceEditorPage, DataSourcesPage } from "./pages/DataSourcesPage";
import { ActivityPage } from "./pages/ActivityPage";
import { PluginsPage } from "./pages/PluginsPage";
import {
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

export const studioRoutes: RouteObject[] = [
  { path: "/setup", element: <AuthPage mode="setup" /> },
  { path: "/login", element: <AuthPage mode="login" /> },
  { path: "/playlists/:id/preview", element: <PlaylistPreviewPage /> },
  {
    path: "/",
    element: <DashboardShell />,
    children: [
      {
        index: true,
        element: <FoundationPage />,
        handle: {
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
      // Plugin-owned routes inside the authenticated chrome (the Forms
      // reviewer inbox), discovered at build time.
      ...pluginStandaloneRouteObjects({ topLevel: false }),
      {
        path: "activity",
        element: <ActivityPage />,
        handle: {
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
  // Plugin-owned top-level routes with their own shell (the Forms submitter
  // portal), discovered at build time.
  ...pluginStandaloneRouteObjects({ topLevel: true }),
  { path: "*", element: <Navigate to="/" replace /> },
];

function RoutedApp() {
  return useRoutes(studioRoutes);
}

export function App() {
  return (
    <>
      <GitHubOAuthSetupPortal />
      <StudioRoutesProvider routes={studioRoutes}>
        <RoutedApp />
      </StudioRoutesProvider>
      <Toaster />
    </>
  );
}
