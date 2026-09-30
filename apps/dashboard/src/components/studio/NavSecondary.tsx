import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
} from "@/components/ui/sidebar";
import type { ResolvedNavigationDestination } from "@/navigation/studioNavigation";
import { NavRow } from "./NavMain";

/**
 * The bottom of the sidebar: Activity, plugin-contributed navigation, and
 * Settings, in the order the navigation model resolved.
 */
export function NavSecondary({
  items,
  activeId,
  className,
}: {
  items: ResolvedNavigationDestination[];
  activeId?: string;
  className?: string;
}) {
  return (
    <SidebarGroup className={className}>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <NavRow key={item.id} item={item} activeId={activeId} />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
