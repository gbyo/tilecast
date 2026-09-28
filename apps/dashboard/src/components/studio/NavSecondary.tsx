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
import type { StudioNavItem } from "./NavMain";

export function SecondaryNavRow({ item }: { item: StudioNavItem }) {
  const location = useLocation();
  const active = item.end
    ? location.pathname === item.url
    : location.pathname === item.url ||
      location.pathname.startsWith(`${item.url}/`);
  return (
    <SidebarMenuItem key={item.url}>
      <SidebarMenuButton
        tooltip={item.title}
        isActive={active}
        render={
          <Link to={item.url} aria-current={active ? "page" : undefined} />
        }
      >
        {item.icon}
        <span>{item.title}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function NavSecondary({
  label,
  items,
  children,
  className,
}: {
  label?: string;
  items: StudioNavItem[];
  /**
   * Rows rendered after the static items in the same menu. The sidebar uses
   * this for plugin-contributed navigation: each contributed row manages its
   * own visibility, so hooks stay valid while static entries render first.
   */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <SidebarGroup className={className}>
      {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SecondaryNavRow key={item.url} item={item} />
          ))}
          {children}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
