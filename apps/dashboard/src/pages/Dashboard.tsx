import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { AppSidebar, SidebarNavigation } from "@/components/AppSidebar";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { StudioTopbar } from "@/components/StudioTopbar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EnrollmentWizard } from "./EnrollmentWizard";
import { OperationsDashboard } from "./OperationsDashboard";

export { SidebarNavigation };

export function DashboardShell() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Enrollment is latched rather than read straight from the session flag on
  // every render: confirming the first factor clears the flag server-side, and
  // the wizard still has recovery codes and a passkey to offer after that.
  const [enrolling, setEnrolling] = useState(false);
  const enrollmentFinished = useRef(false);
  const preferences = useQuery({
    queryKey: ["preferences"],
    queryFn: api.preferences,
    enabled: Boolean(auth.status?.authenticated),
  });

  useEffect(() => {
    const values = preferences.data?.values;
    if (!values) return;
    const root = document.documentElement;
    root.dataset.theme =
      typeof values["preference.appearance"] === "string"
        ? values["preference.appearance"]
        : "system";
    root.dataset.density =
      typeof values["preference.density"] === "string"
        ? values["preference.density"]
        : "comfortable";
    root.dataset.reducedMotion = String(
      Boolean(values["preference.reduced_motion"]),
    );
  }, [preferences.data]);

  useEffect(() => {
    if (!auth.isLoading && !auth.status?.authenticated)
      void navigate(
        auth.status?.setupRequired
          ? "/setup"
          : `/login?returnTo=${encodeURIComponent(location.pathname)}`,
        { replace: true },
      );
  }, [auth.isLoading, auth.status, navigate, location.pathname]);

  useEffect(() => {
    if (auth.status?.mfaEnrollmentRequired && !enrollmentFinished.current)
      setEnrolling(true);
  }, [auth.status?.mfaEnrollmentRequired]);

  if (auth.isLoading || !auth.status?.authenticated) return null;

  // The server refuses every dashboard route until the required factor
  // exists, so the shell gives way to enrollment rather than rendering a page
  // whose data will not load.
  if (enrolling)
    return (
      <EnrollmentWizard
        onFinish={() => {
          enrollmentFinished.current = true;
          setEnrolling(false);
        }}
      />
    );

  return (
    <TooltipProvider>
      <SidebarProvider className="style-vega">
        <AppSidebar
          user={auth.status.user}
          signingOut={auth.isSubmitting}
          onLogout={() => void auth.logout()}
        />
        <SidebarInset className="workspace min-w-0 bg-background">
          <StudioTopbar
            leading={<SidebarTrigger className="shrink-0" />}
            user={auth.status.user}
            csrfToken={auth.status.csrfToken}
          />
          <main className="workspace__content min-w-0 flex-1">
            <RouteErrorBoundary key={location.pathname}>
              <div className="workspace__route">
                <Outlet />
              </div>
            </RouteErrorBoundary>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
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
  return (
    <section className="empty-state">
      <span className="empty-state__index">M{milestone}</span>
      <h2>{feature} are not enabled yet.</h2>
      <p>
        This installation currently includes the Milestone 1 foundation.{" "}
        {feature} will be implemented and tested in Milestone {milestone}.
      </p>
      <NavLink className="text-link" to="/">
        Return to installation status
      </NavLink>
    </section>
  );
}
