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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { ClipboardList, Ellipsis, LogOut, UserRound } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { User } from "@/api/types";

export function NavUser({
  user,
  onSignOut,
  disabled = false,
}: {
  user: User;
  onSignOut: () => void;
  disabled?: boolean;
}) {
  const { isMobile } = useSidebar();
  const { t } = useTranslation(["navigation", "common"]);
  // i18n-ignore: avatar initial letter, not language text
  const initial = user.name.trim().slice(0, 1).toLocaleUpperCase() || "T";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="aria-expanded:bg-sidebar-accent"
              />
            }
            aria-label={t("userMenu.openLabel", { name: user.name })}
          >
            <Avatar className="size-8 rounded-md">
              <AvatarFallback className="rounded-md">{initial}</AvatarFallback>
            </Avatar>
            <span className="grid min-w-0 flex-1 text-start text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {user.role}
              </span>
            </span>
            <Ellipsis className="ml-auto size-4" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-48"
            side={isMobile ? "top" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <span className="block truncate font-medium text-foreground">
                  {user.name}
                </span>
                <span className="block truncate text-xs">{user.username}</span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link to="/forms" />}>
              <ClipboardList aria-hidden="true" />
              {t("userMenu.myForms")}
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link to="/account" />}>
              <UserRound aria-hidden="true" />
              {t("userMenu.myAccount")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSignOut} disabled={disabled}>
              <LogOut aria-hidden="true" />
              {t("userMenu.signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
