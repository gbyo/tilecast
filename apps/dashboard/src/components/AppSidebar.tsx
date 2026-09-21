import {
  Activity,
  CalendarDays,
  ChevronsUpDown,
  ClipboardCheck,
  ClipboardList,
  Home,
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
} from "@/navigation/WorkspaceTabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
  SidebarGroupLabel,
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
            <Avatar className="size-8 rounded-md">
              <AvatarFallback className="rounded-md text-xs font-semibold">
                {initial}
              </AvatarFallback>
            </Avatar>
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
        <SidebarGroupLabel>Studio</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {primaryItems.map((item) => (
              <NavDestination key={item.to} item={item} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel>Content</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {contentTabs.map((item) => (
              <NavDestination key={item.to} item={item} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel>Presentations</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {presentationTabs.map((item) => (
              <NavDestination key={item.to} item={item} />
            ))}
            <NavDestination
              item={{
                label: "Schedules",
                to: "/schedules",
                icon: CalendarDays,
              }}
            />
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="mt-auto">
        <SidebarGroupLabel>System</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <NavDestination
              item={{ label: "Plugins", to: "/plugins", icon: Puzzle }}
            />
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
            <NavDestination
              item={{ label: "Settings", to: "/settings", icon: Settings }}
            />
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
    <Sidebar variant="inset" collapsible="icon">
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
                <span className="truncate text-xs text-muted-foreground">
                  Studio
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarNavigation />

      <SidebarFooter>
        <AccountMenu user={user} signingOut={signingOut} onLogout={onLogout} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
