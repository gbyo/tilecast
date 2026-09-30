import { Link } from "react-router";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { NavigationIcon } from "@/navigation/NavigationIcon";
import type {
  ResolvedNavigationDestination,
  ResolvedNavigationGroup,
} from "@/navigation/studioNavigation";

export function NavRow({
  item,
  activeId,
}: {
  item: ResolvedNavigationDestination;
  activeId?: string;
}) {
  const active = item.id === activeId;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={item.title}
        isActive={active}
        render={
          <Link to={item.to} aria-current={active ? "page" : undefined} />
        }
      >
        <NavigationIcon token={item.icon} component={item.Icon} />
        <span>{item.title}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function NavigationGroup({
  group,
  activeId,
}: {
  group: ResolvedNavigationGroup;
  activeId?: string;
}) {
  return (
    <SidebarGroup>
      {group.title ? (
        <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
      ) : null}
      <SidebarGroupContent>
        <SidebarMenu>
          {group.items.map((item) => (
            <NavRow key={item.id} item={item} activeId={activeId} />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function NavMain({
  groups,
  activeId,
}: {
  groups: ResolvedNavigationGroup[];
  activeId?: string;
}) {
  return (
    <>
      {groups.map((group) => (
        <NavigationGroup key={group.id} group={group} activeId={activeId} />
      ))}
    </>
  );
}
