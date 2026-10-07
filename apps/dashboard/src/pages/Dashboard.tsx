import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { accountQueries } from "@/data/account";
import type { User } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { authReturnTo } from "@/auth/returnTo";
import { AppSidebar } from "@/components/studio/AppSidebar";
import { ThemeProvider } from "@/components/studio/ThemeProvider";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { DemoModeBanner } from "@/components/DemoModeBanner";
import { StudioTopbar } from "@/components/StudioTopbar";
import { EditorHeaderProvider } from "@/components/studio/EditorHeaderSlots";
import { WidgetSnapshotQueue } from "@/components/content/widget-editor/WidgetSnapshotQueue";
import {
  StudioNavigationProvider,
  useStudioNavigation,
} from "@/navigation/studioNavigation";
import { useNativeNavigation } from "@/native-host/useNativeNavigation";
import {
  isImmersiveEditorRoute,
  useStudioRoutes,
} from "@/navigation/studioRoutes";
import {
  LANGUAGE_PREFERENCE_KEY,
  applyLanguagePreference,
  isLanguagePreference,
} from "@/i18n";
import { OperationsDashboard } from "./OperationsDashboard";
import { EnrollmentWizard } from "./EnrollmentWizard";

const sidebarOpenKey = "tilecast.sidebar.open";
const legacySidebarCompactKey = "tilecast.sidebar.compact";
const appearanceKey = "tilecast.appearance";

function readSidebarOpen() {
  try {
    const saved = window.localStorage.getItem(sidebarOpenKey);
    if (saved === "true" || saved === "false") return saved === "true";
    return window.localStorage.getItem(legacySidebarCompactKey) !== "true";
  } catch {
    return true;
  }
}

function readAppearance() {
  try {
    const value = window.localStorage.getItem(appearanceKey);
    return value === "light" || value === "dark" || value === "system"
      ? value
      : "system";
  } catch {
    return "system";
  }
}

/**
 * Studio's appearance, density, and motion from the account's saved
 * preferences, falling back to the appearance cached in this browser. Every
 * signed-in Studio surface uses it, so a native presentation looks like the
 * page that opened it.
 */
export function studioTheme(values: Record<string, unknown> | undefined) {
  const appearance =
    typeof values?.["preference.appearance"] === "string"
      ? String(values["preference.appearance"])
      : readAppearance();
  const density =
    typeof values?.["preference.density"] === "string"
      ? String(values["preference.density"])
      : "comfortable";
  return {
    appearance,
    density,
    reducedMotion: Boolean(values?.["preference.reduced_motion"]),
  };
}

export function DashboardShell() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);
  // Enrollment is latched because confirming the first factor clears the session
  // flag before the wizard finishes offering recovery codes and passkeys.
  const [enrolling, setEnrolling] = useState(false);
  const enrollmentFinished = useRef(false);
  const preferences = useQuery({
    ...accountQueries.preferences(),
    enabled: Boolean(auth.status?.authenticated),
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(sidebarOpenKey, String(sidebarOpen));
    } catch {
      // The built-in sidebar still works when browser storage is unavailable.
    }
  }, [sidebarOpen]);
  const serverAppearance =
    typeof preferences.data?.values?.["preference.appearance"] === "string"
      ? String(preferences.data.values["preference.appearance"])
      : null;
  useEffect(() => {
    // Keep the first-paint bootstrap value in sync with the resolved server
    // preference so reloads do not briefly flash a stale local appearance.
    if (!serverAppearance) return;
    try {
      if (window.localStorage.getItem(appearanceKey) !== serverAppearance) {
        window.localStorage.setItem(appearanceKey, serverAppearance);
      }
    } catch {
      // Preference state remains available from the server when storage is disabled.
    }
  }, [serverAppearance]);
  const serverLanguage = preferences.data?.values?.[LANGUAGE_PREFERENCE_KEY];
  useEffect(() => {
    // The cached value chose the starting language; the account's saved
    // preference is authoritative once it arrives.
    if (isLanguagePreference(serverLanguage)) {
      applyLanguagePreference(serverLanguage);
    }
  }, [serverLanguage]);
  useEffect(() => {
    if (!auth.isLoading && !auth.status?.authenticated) {
      const returnTo = authReturnTo({
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
      });
      void navigate(
        auth.status?.setupRequired
          ? "/setup"
          : `/login?returnTo=${encodeURIComponent(returnTo)}`,
        { replace: true },
      );
    }
  }, [
    auth.isLoading,
    auth.status,
    navigate,
    location.pathname,
    location.search,
    location.hash,
  ]);
  useEffect(() => {
    if (auth.status?.mfaEnrollmentRequired && !enrollmentFinished.current) {
      setEnrolling(true);
    }
  }, [auth.status?.mfaEnrollmentRequired]);

  if (auth.isLoading || !auth.status?.authenticated) return null;
  if (enrolling) {
    return (
      <EnrollmentWizard
        onFinish={() => {
          enrollmentFinished.current = true;
          setEnrolling(false);
        }}
      />
    );
  }

  const user = auth.status.user;
  if (!user) return null;

  return (
    <ThemeProvider {...studioTheme(preferences.data?.values)}>
      <StudioNavigationProvider>
        <StudioChrome
          user={user}
          sidebarOpen={sidebarOpen}
          onSidebarOpenChange={setSidebarOpen}
        />
      </StudioNavigationProvider>
    </ThemeProvider>
  );
}

/**
 * The authenticated Studio chrome. A native host that negotiated native
 * navigation replaces only the sidebar: the topbar, breadcrumbs, search,
 * notifications, editor headers, and every page stay here.
 */
function StudioChrome({
  user,
  sidebarOpen,
  onSidebarOpenChange,
}: {
  user: User;
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
}) {
  const auth = useAuth();
  const location = useLocation();
  const navigation = useStudioNavigation();
  const hosted = useNativeNavigation(navigation) !== "browser";
  // Immersive editors (Layouts, Widgets) are full-bleed workspaces with one
  // merged header; their routes say so in their handle.
  const routes = useStudioRoutes();
  const editorRoute = isImmersiveEditorRoute(routes, location.pathname);
  const signOut = () => void auth.logout();

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={onSidebarOpenChange}>
      {hosted ? null : (
        <AppSidebar
          user={user}
          onSignOut={signOut}
          signOutDisabled={auth.isSubmitting}
        />
      )}
      <SidebarInset className="min-h-svh overflow-hidden">
        <EditorHeaderProvider>
          {auth.status?.demoMode && !editorRoute ? <DemoModeBanner /> : null}
          <StudioTopbar
            user={user}
            csrfToken={auth.status?.csrfToken}
            editor={editorRoute}
            demoMode={Boolean(auth.status?.demoMode)}
            nativeNavigation={hosted}
            onSignOut={signOut}
            signOutDisabled={auth.isSubmitting}
          />
          <div
            className={
              editorRoute
                ? "min-h-0 flex-1 overflow-auto"
                : "min-h-0 flex-1 overflow-auto px-4 py-5 md:px-7 md:py-6"
            }
          >
            <RouteErrorBoundary key={location.pathname}>
              <Outlet />
            </RouteErrorBoundary>
          </div>
          {/* Saved Widgets capture their thumbnails here, outside any one
              route, so leaving the editor never cancels a capture. */}
          <WidgetSnapshotQueue />
        </EditorHeaderProvider>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function FoundationPage() {
  return <OperationsDashboard />;
}

export function PlannedPage({
  feature,
  milestone,
}: {
  feature: string;
  milestone: number;
}) {
  const { t } = useTranslation("common");
  return (
    <section className="mx-auto max-w-2xl py-12">
      <p className="text-xs font-medium tracking-wide text-muted-foreground">
        {t("planned.eyebrow", { milestone })}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        {t("planned.title", { feature })}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("planned.body", { feature, milestone })}
      </p>
      <NavLink className="mt-4 inline-flex text-sm underline" to="/">
        {t("planned.backLink")}
      </NavLink>
    </section>
  );
}
