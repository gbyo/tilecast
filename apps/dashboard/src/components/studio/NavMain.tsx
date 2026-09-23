import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
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
  match?: string[];
};

export function NavMain({
  label = "Main",
  items,
}: {
  label?: string;
  items: StudioNavItem[];
}) {
  const location = useLocation();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const active = item.end
              ? location.pathname === item.url
              : item.match?.some(
                  (path) =>
                    location.pathname === path ||
                    location.pathname.startsWith(`${path}/`),
                ) ||
                location.pathname === item.url ||
                location.pathname.startsWith(`${item.url}/`);
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
