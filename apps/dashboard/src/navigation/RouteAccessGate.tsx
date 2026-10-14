import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { LockKeyhole } from "lucide-react";
import { requirementMet, useCapabilities } from "../auth/capabilities";
import { buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { useStudioNavigation } from "./studioNavigation";
import { routeRequirement, useStudioRoutes } from "./studioRoutes";

/**
 * Where an account lands: the first destination its role can use, in
 * navigation order. An account that can use none of them still has its own
 * preferences and security.
 */
export function useLandingPath(): string {
  const navigation = useStudioNavigation();
  return navigation.destinations[0]?.to ?? "/account/preferences";
}

/**
 * Refuses a route the account's role cannot use, however it was reached: a
 * typed address, a bookmark, or a stale link. The Overview at "/" sends the
 * account to its own landing page instead, so a Media-only role opens Media.
 * This is the same requirement the sidebar and command search read; the API
 * still decides every request on its own.
 */
export function RouteAccessGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const routes = useStudioRoutes();
  const capabilities = useCapabilities();
  const landing = useLandingPath();
  const navigation = useStudioNavigation();
  const { t } = useTranslation("navigation");
  const requirement = routeRequirement(routes, location.pathname);
  if (requirementMet(requirement, capabilities)) return <>{children}</>;
  if (location.pathname === "/" && landing !== "/") {
    return <Navigate to={landing} replace />;
  }
  const destination = navigation.destinations.find(
    (item) => item.to === landing,
  );
  return (
    <Empty className="mx-auto max-w-lg py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LockKeyhole size={24} aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{t("access.deniedTitle")}</EmptyTitle>
        <EmptyDescription>{t("access.deniedDescription")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link to={landing} className={buttonVariants({ variant: "default" })}>
          {destination
            ? t("access.goTo", { destination: destination.title })
            : t("access.goToAccount")}
        </Link>
      </EmptyContent>
    </Empty>
  );
}
