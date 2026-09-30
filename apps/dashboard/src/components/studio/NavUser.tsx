import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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

type UserMenuProps = {
  user: User;
  onSignOut: () => void;
  disabled?: boolean;
};

function userInitial(user: User) {
  // i18n-ignore: avatar initial letter, not language text
  return user.name.trim().slice(0, 1).toLocaleUpperCase() || "T";
}

/** The account menu's contents, shared by every place that opens it. */
function UserMenuItems({ user, onSignOut, disabled = false }: UserMenuProps) {
  const { t } = useTranslation(["navigation", "common"]);
  return (
    <>
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
    </>
  );
}

/** The account menu in the browser sidebar footer. */
export function NavUser(props: UserMenuProps) {
  const { user } = props;
  const { isMobile } = useSidebar();
  const { t } = useTranslation(["navigation", "common"]);

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
              <AvatarFallback className="rounded-md">
                {userInitial(user)}
              </AvatarFallback>
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
            <UserMenuItems {...props} />
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/**
 * The same account menu in the Studio topbar. A native host that replaces the
 * sidebar with its own navigation still needs account access and sign out.
 */
export function TopbarUserMenu(props: UserMenuProps) {
  const { user } = props;
  const { t } = useTranslation(["navigation", "common"]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" />}
        aria-label={t("userMenu.openLabel", { name: user.name })}
      >
        <Avatar className="size-7 rounded-md">
          <AvatarFallback className="rounded-md text-xs">
            {userInitial(user)}
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="min-w-48"
        side="bottom"
        align="end"
        sideOffset={4}
      >
        <UserMenuItems {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
