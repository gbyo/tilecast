import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { User } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { AppSidebar } from "@/components/studio/AppSidebar";
import { ThemeProvider } from "@/components/studio/ThemeProvider";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { StudioTopbar } from "@/components/StudioTopbar";
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
    queryKey: ["preferences"],
    queryFn: api.preferences,
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
      void navigate(
        auth.status?.setupRequired
          ? "/setup"
          : `/login?returnTo=${encodeURIComponent(location.pathname)}`,
        { replace: true },
      );
    }
  }, [auth.isLoading, auth.status, navigate, location.pathname]);
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

  const values = preferences.data?.values;
  const appearance = serverAppearance ?? readAppearance();
  const density =
    typeof values?.["preference.density"] === "string"
      ? String(values["preference.density"])
      : "comfortable";
  const reducedMotion = Boolean(values?.["preference.reduced_motion"]);
  const user = auth.status.user;
  if (!user) return null;

  return (
    <ThemeProvider
      appearance={appearance}
      density={density}
      reducedMotion={reducedMotion}
    >
      <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <AppSidebar
          user={user}
          onSignOut={() => void auth.logout()}
          signOutDisabled={auth.isSubmitting}
        />
        <SidebarInset className="min-h-svh overflow-hidden">
          <StudioTopbar user={user} csrfToken={auth.status.csrfToken} />
          <div className="min-h-0 flex-1 overflow-auto px-4 py-5 md:px-7 md:py-6">
            <RouteErrorBoundary key={location.pathname}>
              <Outlet />
            </RouteErrorBoundary>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </ThemeProvider>
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

// Kept as a small navigation-only fixture for the existing capability tests.
export function SidebarNavigation() {
  const user: User = {
    id: "navigation-test-user",
    name: "Tilecast User",
    username: "tilecast",
    role: "owner",
    active: true,
    createdAt: "",
  };
  return (
    <SidebarProvider>
      <AppSidebar user={user} onSignOut={() => undefined} />
    </SidebarProvider>
  );
}
