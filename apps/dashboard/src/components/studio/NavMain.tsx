import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";

export type StudioNavChild = {
  title: string;
  url: string;
};

export type StudioNavItem = {
  title: string;
  url: string;
  icon: ReactNode;
  end?: boolean;
  match?: string[];
  children?: StudioNavChild[];
};

function matches(pathname: string, url: string, end?: boolean) {
  if (end) return pathname === url;
  return pathname === url || pathname.startsWith(`${url}/`);
}

function matchesAny(
  pathname: string,
  item: Pick<StudioNavItem, "url" | "end" | "match">,
) {
  if (matches(pathname, item.url, item.end)) return true;
  return Boolean(item.match?.some((path) => matches(pathname, path)));
}

/** The child that owns the route: exact match wins, else longest prefix. */
function activeChild(
  pathname: string,
  children: StudioNavChild[],
): StudioNavChild | undefined {
  const exact = children.find((child) => pathname === child.url);
  if (exact) return exact;
  let best: StudioNavChild | undefined;
  for (const child of children) {
    if (!pathname.startsWith(`${child.url}/`)) continue;
    if (!best || child.url.length > best.url.length) best = child;
  }
  return best;
}

function FlatItem({ item, active }: { item: StudioNavItem; active: boolean }) {
  return (
    <SidebarMenuItem>
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

function GroupItem({ item }: { item: StudioNavItem }) {
  const location = useLocation();
  const pathname = location.pathname;
  const owned = activeChild(pathname, item.children ?? []);
  const groupActive =
    matchesAny(pathname, item) ||
    (item.children ?? []).some((child) => matches(pathname, child.url));
  // The group opens on its own when the active route lives inside it, and
  // the user can still collapse or expand it afterwards. Navigating to
  // another route in the same group re-opens it.
  const [open, setOpen] = useState(groupActive);
  useEffect(() => {
    if (groupActive) setOpen(true);
  }, [groupActive, item.title]);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<SidebarMenuItem />}
    >
      <SidebarMenuButton
        tooltip={item.title}
        isActive={groupActive}
        render={
          <Link to={item.url} aria-current={groupActive ? "page" : undefined} />
        }
      >
        {item.icon}
        <span>{item.title}</span>
      </SidebarMenuButton>
      <CollapsibleTrigger
        aria-label={`Toggle ${item.title} submenu`}
        aria-expanded={open}
        render={<SidebarMenuAction className="aria-expanded:rotate-90" />}
      >
        <ChevronRight aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SidebarMenuSub>
          {(item.children ?? []).map((child) => {
            const childActive = owned === child;
            return (
              <SidebarMenuSubItem key={child.url}>
                <SidebarMenuSubButton
                  isActive={childActive}
                  render={
                    <Link
                      to={child.url}
                      aria-current={childActive ? "page" : undefined}
                    />
                  }
                >
                  <span>{child.title}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            );
          })}
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  );
}

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
          {items.map((item) =>
            item.children?.length ? (
              <GroupItem key={item.title} item={item} />
            ) : (
              <FlatItem
                key={item.url}
                item={item}
                active={matchesAny(location.pathname, item)}
              />
            ),
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
