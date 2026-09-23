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
import { useTranslation } from "react-i18next";
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

// Navigation structures hold translation keys, never rendered text. Labels
// are resolved with t() at render so the sidebar follows language changes.
const navigationGroups = [
  {
    labelKey: "groups.screens",
    items: [
      { titleKey: "items.fleet", url: "/screens", icon: <Monitor /> },
      { titleKey: "items.displayGroups", url: "/groups", icon: <Users /> },
      { titleKey: "items.archive", url: "/screens/archive", icon: <Archive /> },
    ],
  },
  {
    labelKey: "groups.content",
    items: [
      { titleKey: "items.media", url: "/assets", icon: <Image /> },
      { titleKey: "items.widgets", url: "/widgets", icon: <Blocks /> },
      {
        titleKey: "items.dataSources",
        url: "/data-sources",
        icon: <Database />,
      },
    ],
  },
  {
    labelKey: "groups.presentations",
    items: [
      { titleKey: "items.playlists", url: "/playlists", icon: <ListVideo /> },
      { titleKey: "items.layouts", url: "/layouts", icon: <PanelsTopLeft /> },
      { titleKey: "items.campaigns", url: "/campaigns", icon: <Megaphone /> },
    ],
  },
  {
    labelKey: "groups.operations",
    items: [
      {
        titleKey: "items.schedules",
        url: "/schedules",
        icon: <CalendarClock />,
      },
      { titleKey: "items.plugins", url: "/plugins", icon: <Puzzle /> },
    ],
  },
] as const;

export function AppSidebar({
  user,
  onSignOut,
  signOutDisabled,
}: {
  user: User;
  onSignOut: () => void;
  signOutDisabled?: boolean;
}) {
  const { t } = useTranslation(["navigation", "common"]);
  const forms = useQuery({
    queryKey: ["forms"],
    queryFn: api.listForms,
    retry: false,
  });
  const canReview = (forms.data ?? []).some((form) =>
    canReviewForm(form.grantedCapabilities),
  );

  const secondaryItems = [
    { title: t("items.activity"), url: "/activity", icon: <Activity /> },
    ...(canReview
      ? [
          {
            title: t("items.approvals"),
            url: "/approvals",
            icon: <ClipboardCheck />,
          },
        ]
      : []),
    { title: t("items.settings"), url: "/settings", icon: <Settings /> },
  ];

  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader className="px-2 pt-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="px-2"
              render={<Link to="/" aria-label={t("brand.home")} />}
            >
              <Brand />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-0 py-2">
        <NavMain
          overview={{
            title: t("overview"),
            url: "/",
            icon: <Home />,
            end: true,
          }}
          groups={navigationGroups.map((group) => ({
            label: t(group.labelKey),
            items: group.items.map((item) => ({
              title: t(item.titleKey),
              url: item.url,
              icon: item.icon,
            })),
          }))}
        />
        <NavSecondary className="mt-auto" items={secondaryItems} />
      </SidebarContent>
      <SidebarFooter className="p-2">
        <NavUser user={user} onSignOut={onSignOut} disabled={signOutDisabled} />
      </SidebarFooter>
    </Sidebar>
  );
}
