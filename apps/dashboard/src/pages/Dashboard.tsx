import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate } from "react-router";
import {
  SideNav,
  SideNavHeader,
  SideNavItem,
  SideNavItemContent,
  SideNavItemLink,
  SideNavSection,
  Text,
} from "@react-spectrum/s2/SideNav";
import { ActionButton } from "@react-spectrum/s2/ActionButton";
import { Avatar } from "@react-spectrum/s2/Avatar";
import { Menu, MenuItem, MenuTrigger } from "@react-spectrum/s2/Menu";
import { Popover } from "@react-spectrum/s2/Popover";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import AppsIcon from "@react-spectrum/s2/icons/Apps";
import CalendarIcon from "@react-spectrum/s2/icons/Calendar";
import ClockIcon from "@react-spectrum/s2/icons/Clock";
import DataIcon from "@react-spectrum/s2/icons/Data";
import DeviceDesktopIcon from "@react-spectrum/s2/icons/DeviceDesktop";
import FilesIcon from "@react-spectrum/s2/icons/Files";
import HomeIcon from "@react-spectrum/s2/icons/Home";
import ImagesIcon from "@react-spectrum/s2/icons/Images";
import LayersIcon from "@react-spectrum/s2/icons/Layers";
import PluginIcon from "@react-spectrum/s2/icons/Plugin";
import SettingsIcon from "@react-spectrum/s2/icons/Settings";
import UserIcon from "@react-spectrum/s2/icons/User";
import UserGroupIcon from "@react-spectrum/s2/icons/UserGroup";
import { useAuth } from "../auth/AuthProvider";
import { api } from "../api/client";
import type { FormSummary } from "../api/types";
import { Brand } from "../components/Brand";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import { StudioTopbar } from "../components/StudioTopbar";
import { canReviewForm } from "../forms/capabilities";
import { OperationsDashboard } from "./OperationsDashboard";
import { EnrollmentWizard } from "./EnrollmentWizard";

const shellStyles = style({
  display: "grid",
  gridTemplateColumns: {
    default: "minmax(0, 1fr)",
    lg: "15rem minmax(0, 1fr)",
  },
  minHeight: "100vh",
});

const sidebarStyles = style({
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  backgroundColor: "layer-1",
  borderEndWidth: 1,
  borderColor: "gray-200",
  position: { default: "relative", lg: "sticky" },
  top: 0,
  height: { default: "auto", lg: "100vh" },
});

const brandStyles = style({
  display: "flex",
  alignItems: "center",
  minHeight: 64,
  paddingX: 20,
  borderBottomWidth: 1,
  borderColor: "gray-200",
});

const navStyles = style({
  flexGrow: 1,
  minHeight: 0,
  width: "full",
  height: { default: 250, lg: "full" },
});

const accountStyles = style({
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: 12,
  borderTopWidth: 1,
  borderColor: "gray-200",
});

const accountCopyStyles = style({
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  flexGrow: 1,
});

const workspaceStyles = style({
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr)",
  minWidth: 0,
  minHeight: "100vh",
});

const mainStyles = style({
  minWidth: 0,
  padding: { default: 16, md: 24, xl: 32 },
});

type NavigationEntryProps = {
  id?: string;
  href: string;
  label: string;
  icon?: ReactNode;
  children?: ReactNode;
};

function NavigationEntry({ href, label, icon, children, id }: NavigationEntryProps) {
  return (
    <SideNavItem id={id ?? href} href={href} textValue={label}>
      <SideNavItemContent>
        <SideNavItemLink>
          {icon}
          <Text>{label}</Text>
        </SideNavItemLink>
      </SideNavItemContent>
      {children}
    </SideNavItem>
  );
}

function NavigationLeaf({ href, label }: { href: string; label: string }) {
  return (
    <SideNavItem id={href} href={href} textValue={label}>
      <SideNavItemContent>
        <SideNavItemLink>
          <Text>{label}</Text>
        </SideNavItemLink>
      </SideNavItemContent>
    </SideNavItem>
  );
}

export function selectedStudioNavigationRoute(pathname: string) {
  const routes = [
    "/",
    "/screens",
    "/groups",
    "/screens/archive",
    "/assets",
    "/widgets",
    "/data-sources",
    "/playlists",
    "/layouts",
    "/campaigns",
    "/schedules",
    "/plugins",
    "/activity",
    "/approvals",
  ];
  const match = routes
    .filter(
      (route) =>
        pathname === route ||
        (route !== "/" && pathname.startsWith(`${route}/`)),
    )
    .sort((left, right) => right.length - left.length)[0];
  return match ?? (pathname.startsWith("/settings") ? "/settings/general" : null);
}

export function canSeeApprovals(forms: FormSummary[]) {
  return forms.some((form) => canReviewForm(form.grantedCapabilities));
}

export function SidebarNavigation() {
  const location = useLocation();
  const forms = useQuery({
    queryKey: ["forms"],
    queryFn: api.listForms,
    retry: false,
  });
  const canReview = canSeeApprovals(forms.data ?? []);

  return (
    <SideNav
      aria-label="Primary navigation"
      selectedRoute={selectedStudioNavigationRoute(location.pathname)}
      defaultExpandedKeys={[
        "/screens",
        "workspace-content",
        "workspace-presentations",
      ]}
      styles={navStyles}
    >
      <SideNavSection>
        <NavigationEntry
          href="/"
          label="Overview"
          icon={<HomeIcon aria-hidden="true" />}
        />
        <NavigationEntry
          href="/screens"
          label="Screens"
          icon={<DeviceDesktopIcon aria-hidden="true" />}
        >
          <NavigationLeaf href="/groups" label="Display Groups" />
          <NavigationLeaf href="/screens/archive" label="Archive" />
        </NavigationEntry>
      </SideNavSection>
      <SideNavSection>
        <SideNavHeader>Workspaces</SideNavHeader>
        <NavigationEntry
          id="workspace-content"
          href="/assets"
          label="Content"
          icon={<FilesIcon aria-hidden="true" />}
        >
          <NavigationLeaf href="/assets" label="Media" />
          <NavigationLeaf href="/widgets" label="Widgets" />
          <NavigationLeaf href="/data-sources" label="Data" />
        </NavigationEntry>
        <NavigationEntry
          id="workspace-presentations"
          href="/playlists"
          label="Presentations"
          icon={<LayersIcon aria-hidden="true" />}
        >
          <NavigationLeaf href="/playlists" label="Playlists" />
          <NavigationLeaf href="/layouts" label="Layouts" />
          <NavigationLeaf href="/campaigns" label="Campaigns" />
        </NavigationEntry>
        <NavigationEntry
          href="/schedules"
          label="Schedules"
          icon={<CalendarIcon aria-hidden="true" />}
        />
        <NavigationEntry
          href="/plugins"
          label="Plugins"
          icon={<PluginIcon aria-hidden="true" />}
        />
      </SideNavSection>
      <SideNavSection>
        <SideNavHeader>Monitor</SideNavHeader>
        <NavigationEntry
          href="/activity"
          label="Activity"
          icon={<ClockIcon aria-hidden="true" />}
        />
        {canReview && (
          <NavigationEntry
            href="/approvals"
            label="Approvals"
            icon={<UserGroupIcon aria-hidden="true" />}
          />
        )}
      </SideNavSection>
      <SideNavSection>
        <SideNavHeader>Manage</SideNavHeader>
        <NavigationEntry
          href="/settings/general"
          label="Settings"
          icon={<SettingsIcon aria-hidden="true" />}
        />
      </SideNavSection>
    </SideNav>
  );
}

function AccountMenu({
  name,
  role,
  onSignOut,
  isSigningOut,
}: {
  name: string;
  role: string;
  onSignOut: () => void;
  isSigningOut: boolean;
}) {
  const navigate = useNavigate();

  return (
    <div className={accountStyles}>
      <Avatar alt={name} size={36} />
      <div className={accountCopyStyles}>
        <Text>{name}</Text>
        <Text>{role}</Text>
      </div>
      <MenuTrigger align="end">
        <ActionButton aria-label="Open account menu">
          <UserIcon aria-hidden="true" />
        </ActionButton>
        <Popover>
          <Menu
            aria-label="Account actions"
            onAction={(key) => {
              if (key === "forms") void navigate("/forms");
              if (key === "account") void navigate("/account");
              if (key === "sign-out") onSignOut();
            }}
          >
            <MenuItem id="forms">My Forms</MenuItem>
            <MenuItem id="account">My Account</MenuItem>
            <MenuItem id="sign-out" isDisabled={isSigningOut}>
              Sign out
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
    </div>
  );
}

export function DashboardShell() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
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
    const appearance =
      typeof values["preference.appearance"] === "string"
        ? values["preference.appearance"]
        : "system";
    root.dataset.appearance = appearance;
    root.dataset.theme = appearance;
    if (appearance === "light" || appearance === "dark")
      root.dataset.colorScheme = appearance;
    else delete root.dataset.colorScheme;
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
    <div className={shellStyles}>
      <aside className={sidebarStyles}>
        <div className={brandStyles}>
          <Brand compact />
        </div>
        <SidebarNavigation />
        <AccountMenu
          name={auth.status.user?.name ?? "Account"}
          role={auth.status.user?.role ?? ""}
          onSignOut={() => void auth.logout()}
          isSigningOut={auth.isSubmitting}
        />
      </aside>
      <div className={workspaceStyles}>
        <StudioTopbar
          user={auth.status.user}
          csrfToken={auth.status.csrfToken}
        />
        <main className={mainStyles}>
          <RouteErrorBoundary key={location.pathname}>
            <Outlet />
          </RouteErrorBoundary>
        </main>
      </div>
    </div>
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
      <a className="text-link" href="/">
        Return to installation status
      </a>
    </section>
  );
}
