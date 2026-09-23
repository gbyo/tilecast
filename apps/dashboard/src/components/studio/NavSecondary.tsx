import { Link, useLocation } from "react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { StudioNavItem } from "./NavMain";

export function NavSecondary({
  label,
  items,
  className,
}: {
  label: string;
  items: StudioNavItem[];
  className?: string;
}) {
  const location = useLocation();

  return (
    <SidebarGroup className={className}>
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
