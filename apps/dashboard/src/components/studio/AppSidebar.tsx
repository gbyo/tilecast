import { Link, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
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
import {
  resolveActiveDestination,
  useStudioNavigation,
} from "@/navigation/studioNavigation";
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
  const { t } = useTranslation(["navigation", "common"]);
  // The browser sidebar renders the same resolved model that native hosts
  // receive as their navigation catalog.
  const navigation = useStudioNavigation();
  const { pathname } = useLocation();
  const activeId = resolveActiveDestination(
    pathname,
    navigation.destinations,
  )?.id;
  const main = navigation.groups.filter((group) => group.placement === "main");
  const secondary = navigation.groups
    .filter((group) => group.placement === "secondary")
    .flatMap((group) => group.items);

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
        <NavMain groups={main} activeId={activeId} />
        <NavSecondary
          className="mt-auto"
          items={secondary}
          activeId={activeId}
        />
      </SidebarContent>
      <SidebarFooter className="p-2">
        <NavUser user={user} onSignOut={onSignOut} disabled={signOutDisabled} />
      </SidebarFooter>
    </Sidebar>
  );
}
