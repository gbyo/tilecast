import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CalendarDays,
  ClipboardCheck,
  Home,
  Layers3,
  Library,
  Monitor,
  Puzzle,
  Settings,
} from "lucide-react";
import { Link } from "react-router";
import { api } from "@/api/client";
import type { User } from "@/api/types";
import { Brand } from "@/components/Brand";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";
import { canReviewForm } from "@/forms/capabilities";
import { NavMain } from "./NavMain";
import { NavSecondary } from "./NavSecondary";
import { NavUser } from "./NavUser";

export function AppSidebar({
  user,
  onSignOut,
  signOutDisabled,
}: {
  user: User;
  onSignOut: () => void;
  signOutDisabled?: boolean;
}) {
  const forms = useQuery({
    queryKey: ["forms"],
    queryFn: api.listForms,
    retry: false,
  });
  const canReview = (forms.data ?? []).some((form) =>
    canReviewForm(form.grantedCapabilities),
  );

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-3">
        <Link
          to="/"
          aria-label="Tilecast Overview"
          className="flex min-w-0 items-center px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <Brand iconOnlyOnCollapse />
        </Link>
      </SidebarHeader>
      <SidebarContent className="gap-0 py-2">
        <NavMain
          label="Main"
          items={[
            { title: "Overview", url: "/", icon: <Home />, end: true },
            {
              title: "Screens",
              url: "/screens",
              icon: <Monitor />,
              match: ["/groups"],
            },
            {
              title: "Content",
              url: "/assets",
              icon: <Library />,
              match: ["/widgets", "/data-sources"],
            },
            {
              title: "Presentations",
              url: "/playlists",
              icon: <Layers3 />,
              match: ["/layouts", "/campaigns"],
            },
            {
              title: "Schedules",
              url: "/schedules",
              icon: <CalendarDays />,
            },
            { title: "Plugins", url: "/plugins", icon: <Puzzle /> },
          ]}
        />
        <NavSecondary
          label="Monitor"
          items={[
            { title: "Activity", url: "/activity", icon: <Activity /> },
            ...(canReview
              ? [
                  {
                    title: "Approvals",
                    url: "/approvals",
                    icon: <ClipboardCheck />,
                  },
                ]
              : []),
          ]}
        />
      </SidebarContent>
      <SidebarFooter className="gap-1 border-t border-sidebar-border p-2">
        <NavSecondary
          label="Manage"
          items={[{ title: "Settings", url: "/settings", icon: <Settings /> }]}
        />
        <NavUser user={user} onSignOut={onSignOut} disabled={signOutDisabled} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
