import { useLocation, Link } from "react-router";
import type { ReactNode } from "react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export type StudioNavItem = {
  title: string;
  url: string;
  icon: ReactNode;
  end?: boolean;
};

export type StudioNavGroup = {
  label?: string;
  items: StudioNavItem[];
};

function activeUrl(pathname: string, items: StudioNavItem[]) {
  return items
    .filter(
      (item) =>
        pathname === item.url ||
        (!item.end && pathname.startsWith(`${item.url}/`)),
    )
    .sort((left, right) => right.url.length - left.url.length)[0]?.url;
}

function NavigationGroup({
  label,
  items,
  currentUrl,
}: StudioNavGroup & { currentUrl?: string }) {
  return (
    <SidebarGroup>
      {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const active = item.url === currentUrl;
            return (
              <SidebarMenuItem key={item.url}>
                <SidebarMenuButton
                  tooltip={item.title}
                  isActive={active}
                  render={
                    <Link
                      to={item.url}
                      aria-current={active ? "page" : undefined}
                    />
                  }
                >
                  {item.icon}
                  <span>{item.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function NavMain({
  overview,
  groups,
}: {
  overview: StudioNavItem;
  groups: StudioNavGroup[];
}) {
  const { pathname } = useLocation();
  const items = [overview, ...groups.flatMap((group) => group.items)];
  const currentUrl = activeUrl(pathname, items);

  return (
    <>
      <NavigationGroup items={[overview]} currentUrl={currentUrl} />
      {groups.map((group) => (
        <NavigationGroup key={group.label} {...group} currentUrl={currentUrl} />
      ))}
    </>
  );
}
