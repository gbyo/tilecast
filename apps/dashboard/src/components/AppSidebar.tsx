import {
  Activity,
  CalendarDays,
  ChevronRight,
  ChevronsUpDown,
  ClipboardCheck,
  ClipboardList,
  Home,
  Layers3,
  Library,
  LogOut,
  Monitor,
  Puzzle,
  RadioTower,
  Settings,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { api } from "@/api/client";
import type { User } from "@/api/types";
import { canReviewForm } from "@/forms/capabilities";
import {
  contentTabs,
  presentationTabs,
  tabMatchesPath,
  type WorkspaceTab,
} from "@/navigation/WorkspaceTabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

type NavItem = {
  label: string;
  to: string;
  icon: LucideIcon;
};

const primaryItems: readonly NavItem[] = [
  { label: "Overview", to: "/", icon: Home },
  { label: "Screens", to: "/screens", icon: Monitor },
];

const secondaryItems: readonly NavItem[] = [
  { label: "Schedules", to: "/schedules", icon: CalendarDays },
  { label: "Plugins", to: "/plugins", icon: Puzzle },
];

function pathIsActive(pathname: string, to: string) {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

function NavDestination({ item }: { item: NavItem }) {
  const location = useLocation();
  const active = pathIsActive(location.pathname, item.to);
  const Icon = item.icon;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<NavLink to={item.to} />}
        isActive={active}
        tooltip={item.label}
      >
        <Icon aria-hidden="true" />
        <span>{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function WorkspaceDestination({
  label,
  icon: Icon,
  tabs,
}: {
  label: string;
  icon: LucideIcon;
  tabs: readonly WorkspaceTab[];
}) {
  const location = useLocation();
  const active = tabs.some((tab) => tabMatchesPath(tab.to, location.pathname));

  return (
    <Collapsible
      defaultOpen={active}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger
          render={<SidebarMenuButton tooltip={label} isActive={active} />}
        >
          <Icon aria-hidden="true" />
          <span>{label}</span>
          <ChevronRight
            className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90"
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {tabs.map((tab) => {
              const TabIcon = tab.icon;
              const tabActive = tabMatchesPath(tab.to, location.pathname);
              return (
                <SidebarMenuSubItem key={tab.to}>
                  <SidebarMenuSubButton
                    render={<NavLink to={tab.to} />}
                    isActive={tabActive}
                  >
                    <TabIcon aria-hidden="true" />
                    <span>{tab.label}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function AccountMenu({
  user,
  signingOut,
  onLogout,
}: {
  user?: User;
  signingOut: boolean;
  onLogout: () => void;
}) {
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const initial = user?.name?.slice(0, 1).toUpperCase() || "?";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              />
            }
          >
            <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
              {initial}
            </span>
            <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user?.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {user?.role}
              </span>
            </span>
            <ChevronsUpDown className="ml-auto size-4" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-56"
            align="end"
            side={isMobile ? "top" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Account</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => void navigate("/forms")}>
                <ClipboardList aria-hidden="true" />
                My Forms
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void navigate("/account")}>
                <UserRound aria-hidden="true" />
                My Account
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={signingOut}
              onClick={onLogout}
              variant="destructive"
            >
              <LogOut aria-hidden="true" />
              {signingOut ? "Signing out…" : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function SidebarNavigation() {
  const forms = useQuery({
    queryKey: ["forms"],
    queryFn: api.listForms,
    retry: false,
  });
  const canReview = (forms.data ?? []).some((form) =>
    canReviewForm(form.grantedCapabilities),
  );

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {primaryItems.map((item) => (
              <NavDestination key={item.to} item={item} />
            ))}

            <WorkspaceDestination
              label="Content"
              icon={Library}
              tabs={contentTabs}
            />
            <WorkspaceDestination
              label="Presentations"
              icon={Layers3}
              tabs={presentationTabs}
            />

            {secondaryItems.map((item) => (
              <NavDestination key={item.to} item={item} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="mt-auto">
        <SidebarGroupContent>
          <SidebarMenu>
            <NavDestination
              item={{ label: "Activity", to: "/activity", icon: Activity }}
            />
            {canReview && (
              <NavDestination
                item={{
                  label: "Approvals",
                  to: "/approvals",
                  icon: ClipboardCheck,
                }}
              />
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}

export function AppSidebar({
  user,
  signingOut,
  onLogout,
}: {
  user?: User;
  signingOut: boolean;
  onLogout: () => void;
}) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link to="/" />}
              tooltip="Tilecast Studio"
              className="font-semibold"
            >
              <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
                <RadioTower className="size-4" aria-hidden="true" />
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-semibold">Tilecast</span>
                <span className="truncate text-xs text-muted-foreground">Studio</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarNavigation />

      <SidebarFooter>
        <SidebarMenu>
          <NavDestination
            item={{ label: "Settings", to: "/settings", icon: Settings }}
          />
        </SidebarMenu>
        <AccountMenu
          user={user}
          signingOut={signingOut}
          onLogout={onLogout}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
