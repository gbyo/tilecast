import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Archive,
  Blocks,
  CalendarClock,
  ClipboardCheck,
  Database,
  Home,
  Image,
  ListVideo,
  Megaphone,
  Monitor,
  PanelsTopLeft,
  Puzzle,
  Settings,
  Users,
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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { canReviewForm } from "@/forms/capabilities";
import { NavMain } from "./NavMain";
import { NavSecondary } from "./NavSecondary";
import { NavUser } from "./NavUser";

const navigationGroups = [
  {
    label: "Screens",
    items: [
      { title: "Fleet", url: "/screens", icon: <Monitor /> },
      { title: "Display Groups", url: "/groups", icon: <Users /> },
      { title: "Archive", url: "/screens/archive", icon: <Archive /> },
    ],
  },
  {
    label: "Content",
    items: [
      { title: "Media", url: "/assets", icon: <Image /> },
      { title: "Widgets", url: "/widgets", icon: <Blocks /> },
      { title: "Data Sources", url: "/data-sources", icon: <Database /> },
    ],
  },
  {
    label: "Presentations",
    items: [
      { title: "Playlists", url: "/playlists", icon: <ListVideo /> },
      { title: "Layouts", url: "/layouts", icon: <PanelsTopLeft /> },
      { title: "Campaigns", url: "/campaigns", icon: <Megaphone /> },
    ],
  },
  {
    label: "Operations",
    items: [
      { title: "Schedules", url: "/schedules", icon: <CalendarClock /> },
      { title: "Plugins", url: "/plugins", icon: <Puzzle /> },
    ],
  },
];

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

  const secondaryItems = [
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
    { title: "Settings", url: "/settings", icon: <Settings /> },
  ];

  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader className="px-2 pt-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="px-2"
              render={<Link to="/" aria-label="Tilecast Overview" />}
            >
              <Brand />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-0 py-2">
        <NavMain
          overview={{
            title: "Overview",
            url: "/",
            icon: <Home />,
            end: true,
          }}
          groups={navigationGroups}
        />
        <NavSecondary className="mt-auto" items={secondaryItems} />
      </SidebarContent>
      <SidebarFooter className="p-2">
        <NavUser user={user} onSignOut={onSignOut} disabled={signOutDisabled} />
      </SidebarFooter>
    </Sidebar>
  );
}
