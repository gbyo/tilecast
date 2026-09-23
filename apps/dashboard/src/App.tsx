import { Navigate, useRoutes, type RouteObject } from "react-router";
import { AssetFilterPortal } from "./components/AssetFilterPortal";
import { GitHubOAuthSetupPortal } from "./components/GitHubOAuthSetupPortal";
import { StudioRoutesProvider } from "./navigation/studioRoutes";
import { settingsItems } from "./settings/settingsNavigation";
import { AuthPage } from "./pages/AuthPage";
import { DashboardShell, FoundationPage } from "./pages/Dashboard";
import { PairScreenPage, ScreensPage } from "./pages/ScreensPage";
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
  CountdownBarEditorPage,
  CountdownBarsPage,
} from "./pages/CountdownBarsPage";
import { BrandBugEditorPage, BrandBugsPage } from "./pages/BrandBugsPage";
import { NoiseMeterEditorPage, NoiseMetersPage } from "./pages/NoiseMetersPage";
import { NoiseMeterHistoryPage } from "./pages/NoiseMeterHistoryPage";
import { EmergencyAlertsPage } from "./pages/EmergencyAlertsPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import {
  FormsListPage,
  FormsPortalShell,
  FormPortalDetailPage,
  FormPortalSubmissionPage,
} from "./pages/FormsPortalPage";
import { FormsPluginPage } from "./pages/FormsPluginPage";
import { CreateFormDataSourcePage } from "./pages/CreateFormDataSourcePage";
import { FormDataSourcePage } from "./pages/FormDataSourcePage";
import { DependencyGraphPage } from "./pages/DependencyGraphPage";
import { CampaignsPage } from "./pages/CampaignsPage";

const search = (
  label: string,
  description: string,
  to: string,
  keywords?: string[],
) => ({ label, description, to, keywords });

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
          { index: true, element: <ScreensPage /> },
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
            path: "pair",
            element: <PairScreenPage />,
            handle: { breadcrumb: "Pair screen" },
          },
          {
            path: "pair/:code",
            element: <PairScreenPage />,
            handle: { breadcrumb: "Pair screen" },
          },
          {
            path: "pair/request/:requestId",
            element: <PairScreenPage />,
            handle: { breadcrumb: "Pair screen" },
          },
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
            element: <DataSourceEditorPage redirectForms />,
            handle: { breadcrumb: "Create data source" },
          },
          {
            path: "new/:provider",
            element: <DataSourceEditorPage redirectForms />,
            handle: { breadcrumb: "Create data source" },
          },
          {
            path: ":id",
            element: <DataSourceEditorPage redirectForms />,
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
          { path: "submissions", element: <ContentSubmissionInboxPage /> },
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
            "Manage built-in features that operate outside playlists",
            "/plugins",
            [
              "countdown bar",
              "emergency alerts",
              "brand bug",
              "watermark",
              "logo",
              "player features",
            ],
          ),
        },
        children: [
          { index: true, element: <PluginsPage /> },
          {
            path: "dependency-graph",
            element: <DependencyGraphPage />,
            handle: {
              breadcrumb: "Dependency Graph",
              search: search(
                "Dependency Graph",
                "Trace content, presentations, schedules, groups, and screens",
                "/plugins/dependency-graph",
                ["content map", "used by", "relationships", "impact"],
              ),
            },
          },
          {
            path: "countdown-bar",
            element: <CountdownBarsPage />,
            handle: { breadcrumb: "Countdown Bar" },
          },
          {
            path: "countdown-bar/new",
            element: <CountdownBarEditorPage />,
            handle: { breadcrumb: "New instance" },
          },
          {
            path: "countdown-bar/:id",
            element: <CountdownBarEditorPage />,
            handle: { breadcrumb: "Countdown Bar instance" },
          },
          {
            path: "emergency-alerts",
            element: <EmergencyAlertsPage />,
            handle: {
              breadcrumb: "Emergency Alerts",
              // This used to live in Settings, so the words people already
              // search for have to lead here rather than to a dead end.
              search: search(
                "Emergency Alerts",
                "Automatic NWS weather alert monitoring and takeover rules",
                "/plugins/emergency-alerts",
                ["emergency", "weather", "nws", "alerts", "tornado", "warning"],
              ),
            },
          },
          {
            path: "forms",
            element: <FormsPluginPage />,
            handle: {
              breadcrumb: "Forms",
              search: search(
                "Forms",
                "Collect submissions and publish approved records to signage",
                "/plugins/forms",
                ["submissions", "workflow", "approvals"],
              ),
            },
          },
          {
            path: "forms/new",
            element: <CreateFormDataSourcePage />,
            handle: { breadcrumb: "Create form" },
          },
          {
            path: "forms/:id",
            element: <FormDataSourcePage />,
            handle: { breadcrumb: "Form", resource: "form" },
          },
          {
            path: "brand-bug",
            element: <BrandBugsPage />,
            handle: { breadcrumb: "Brand Bug / Watermark" },
          },
          {
            path: "brand-bug/new",
            element: <BrandBugEditorPage />,
            handle: { breadcrumb: "New instance" },
          },
          {
            path: "brand-bug/:id",
            element: <BrandBugEditorPage />,
            handle: { breadcrumb: "Brand Bug instance" },
          },
          {
            path: "noise-meter",
            element: <NoiseMetersPage />,
            handle: { breadcrumb: "Noise Meter" },
          },
          {
            path: "noise-meter/new",
            element: <NoiseMeterEditorPage />,
            handle: { breadcrumb: "New instance" },
          },
          {
            path: "noise-meter/:id",
            element: <NoiseMeterEditorPage />,
            handle: { breadcrumb: "Noise Meter instance" },
          },
          {
            path: "noise-meter/:id/history",
            element: <NoiseMeterHistoryPage />,
            handle: { breadcrumb: "History" },
          },
        ],
      },
      { path: "users", element: <Navigate to="/settings/users" replace /> },
      {
        path: "approvals",
        element: <ApprovalsPage />,
        handle: {
          breadcrumb: "Approvals",
          search: search(
            "Approvals",
            "Review submissions awaiting a decision across your forms",
            "/approvals",
            ["forms", "review", "submissions", "inbox"],
          ),
        },
      },
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
          ...settingsItems.map((item) => ({
            path: item.path,
            element: <SettingsPage />,
            handle: {
              breadcrumb: item.label,
              search: search(
                item.label,
                `${item.label} settings`,
                `/settings/${item.path}`,
                ["settings"],
              ),
            },
          })),
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
  {
    // The Forms portal is an authenticated area outside the full operator sidebar, reachable from
    // the account menu. It does not introduce a new role or account mode.
    path: "/forms",
    element: <FormsPortalShell />,
    children: [
      { index: true, element: <FormsListPage /> },
      { path: ":id", element: <FormPortalDetailPage /> },
      { path: ":id/new", element: <FormPortalSubmissionPage /> },
      {
        path: ":id/submissions/:recordId",
        element: <FormPortalSubmissionPage />,
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
];

function RoutedApp() {
  return useRoutes(studioRoutes);
}

export function App() {
  return (
    <>
      <AssetFilterPortal />
      <GitHubOAuthSetupPortal />
      <StudioRoutesProvider routes={studioRoutes}>
        <RoutedApp />
      </StudioRoutesProvider>
    </>
  );
}
