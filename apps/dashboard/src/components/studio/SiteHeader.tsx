import { Bell, CircleAlert, Search, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import type {
  NotificationFeed,
  NotificationPriority,
} from "@/notifications/useNotifications";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Kbd } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SidebarTrigger } from "@/components/ui/sidebar";

export type StudioBreadcrumb = { label: string; to: string };

const notificationGroups: {
  priority: NotificationPriority;
  label: string;
}[] = [
  { priority: "critical", label: "Critical" },
  { priority: "warning", label: "Needs attention" },
  { priority: "info", label: "Info" },
];

function shortcutLabel() {
  if (typeof navigator === "undefined") return "⌘ K";
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "⌘ K" : "Ctrl K";
}

export function SiteHeader({
  breadcrumbs,
  notifications,
  onSearch,
}: {
  breadcrumbs: StudioBreadcrumb[];
  notifications: NotificationFeed;
  onSearch: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 md:px-6">
      <SidebarTrigger aria-label="Toggle navigation" />
      {breadcrumbs.length > 1 ? (
        <Breadcrumb className="min-w-0 flex-1">
          <BreadcrumbList className="flex-nowrap overflow-hidden">
            {breadcrumbs.map((item, index) => (
              <span className="contents" key={`${item.to}:${item.label}`}>
                {index > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem className="min-w-0">
                  {index === breadcrumbs.length - 1 ? (
                    <BreadcrumbPage className="truncate">
                      {item.label}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink render={<Link to={item.to} />}>
                      <span className="truncate">{item.label}</span>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </span>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      ) : (
        <div className="min-w-0 flex-1" />
      )}

      <Button
        type="button"
        variant="outline"
        className="h-8 w-44 justify-start gap-2 px-2.5 text-muted-foreground sm:w-56"
        aria-haspopup="dialog"
        onClick={onSearch}
      >
        <Search aria-hidden="true" />
        <span className="flex-1 text-left">Search Tilecast</span>
        <Kbd className="hidden shrink-0 sm:inline-flex">{shortcutLabel()}</Kbd>
      </Button>

      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Notifications${notifications.count ? `, ${notifications.count} active` : ""}`}
            />
          }
        >
          <Bell aria-hidden="true" />
          {notifications.count > 0 && (
            <Badge
              variant={
                notifications.topPriority === "critical"
                  ? "destructive"
                  : "secondary"
              }
              className="absolute -top-1 -right-1 h-4 min-w-4 justify-center px-1 text-[10px]"
              aria-hidden="true"
            >
              {notifications.count > 99 ? "99+" : notifications.count}
            </Badge>
          )}
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[min(24rem,calc(100vw-2rem))] gap-3 p-3"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            <span className="text-xs text-muted-foreground">
              {notifications.count || "No"} active
            </span>
          </div>
          {notifications.count === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              You’re all caught up.
            </p>
          ) : (
            <div className="max-h-[min(65vh,28rem)] space-y-3 overflow-y-auto">
              {notificationGroups.map((group) => {
                const items = notifications.items.filter(
                  (item) => item.priority === group.priority,
                );
                if (!items.length) return null;
                const Icon =
                  group.priority === "critical" ? CircleAlert : TriangleAlert;
                return (
                  <section key={group.priority} aria-label={group.label}>
                    <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <Icon className="size-3.5" aria-hidden="true" />
                      {group.label}
                      <span>({items.length})</span>
                    </h3>
                    <ItemGroup className="gap-1">
                      {items.map((item) => (
                        <Item
                          key={item.id}
                          size="xs"
                          variant="muted"
                          render={<Link to={item.to} />}
                          className="gap-2 rounded-md px-2 py-2"
                        >
                          <ItemContent>
                            <ItemTitle>{item.title}</ItemTitle>
                            <ItemDescription>{item.detail}</ItemDescription>
                          </ItemContent>
                        </Item>
                      ))}
                    </ItemGroup>
                  </section>
                );
              })}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </header>
  );
}
