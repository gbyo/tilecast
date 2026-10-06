import {
  Bell,
  CircleAlert,
  FlaskConical,
  Search,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
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
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditorHeaderSlots } from "./EditorHeaderSlots";
import { cn } from "cn";

export type StudioBreadcrumb = { label: string; to: string };

const notificationGroups: {
  priority: NotificationPriority;
  labelKey:
    "header.groups.critical" | "header.groups.warning" | "header.groups.info";
}[] = [
  { priority: "critical", labelKey: "header.groups.critical" },
  { priority: "warning", labelKey: "header.groups.warning" },
  { priority: "info", labelKey: "header.groups.info" },
];

function shortcutLabel() {
  if (typeof navigator === "undefined") return "⌘ K";
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "⌘ K" : "Ctrl K";
}

export function SiteHeader({
  breadcrumbs,
  notifications,
  onSearch,
  editor = false,
  demoMode = false,
  navigationTrigger = true,
  accountMenu,
}: {
  breadcrumbs: StudioBreadcrumb[];
  notifications: NotificationFeed;
  onSearch: () => void;
  /** An immersive editor: one compact header that also hosts its controls. */
  editor?: boolean;
  demoMode?: boolean;
  /** False when a native host provides navigation instead of the sidebar. */
  navigationTrigger?: boolean;
  /** The account menu, when the sidebar that normally holds it is absent. */
  accountMenu?: ReactNode;
}) {
  const { t } = useTranslation(["navigation", "common"]);
  const slots = useEditorHeaderSlots();
  return (
    <header
      className={cn(
        "flex shrink-0 items-center border-b border-border",
        editor ? "h-13 gap-2 pr-2.5 pl-3" : "h-14 gap-3 px-4 md:px-6",
      )}
    >
      {navigationTrigger && (
        <SidebarTrigger aria-label={t("header.toggleNavigation")} />
      )}
      {navigationTrigger && editor && (
        <Separator
          orientation="vertical"
          className="h-4 self-center max-sm:hidden"
        />
      )}
      {breadcrumbs.length > 0 ? (
        <Breadcrumb
          className={cn(
            "min-w-0",
            editor ? "max-sm:flex-1 sm:min-w-24" : "flex-1",
          )}
        >
          <BreadcrumbList className="flex-nowrap overflow-hidden">
            {breadcrumbs.map((item, index) => (
              <span className="contents" key={`${item.to}:${item.label}`}>
                {/* Narrow headers show only the current page; the trail has
                    no room beside the sidebar trigger and search. */}
                {index > 0 && (
                  <BreadcrumbSeparator
                    className={editor ? "max-xl:hidden" : "max-md:hidden"}
                  />
                )}
                <BreadcrumbItem
                  className={cn(
                    "min-w-0",
                    index < breadcrumbs.length - 1 &&
                      (editor ? "max-xl:hidden" : "max-md:hidden"),
                  )}
                >
                  {index === breadcrumbs.length - 1 ? (
                    <BreadcrumbPage
                      className={cn(
                        "truncate",
                        breadcrumbs.length === 1 && "font-semibold",
                      )}
                    >
                      {editor && slots?.rename ? (
                        <button
                          type="button"
                          className="max-w-full truncate rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                          onClick={slots.rename}
                        >
                          {(editor && slots.title) || item.label}
                        </button>
                      ) : (
                        (editor && slots?.title) || item.label
                      )}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      className="truncate"
                      render={<Link to={item.to} />}
                    >
                      {item.label}
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
      {editor && demoMode && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge variant="outline" tabIndex={0} data-testid="demo-badge" />
            }
          >
            {t("common:demo.badge")}
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            <span className="flex items-start gap-2">
              <FlaskConical
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <span>
                <strong className="block">{t("common:demo.title")}</strong>
                {t("common:demo.description")}
              </span>
            </span>
          </TooltipContent>
        </Tooltip>
      )}
      {editor && <div ref={slots?.setLeft} className="contents" />}
      {editor && <div className="min-w-0 flex-1" />}

      <Button
        type="button"
        variant={editor ? "ghost" : "outline"}
        className={cn(
          "size-8 text-muted-foreground",
          !editor && "sm:w-56 sm:justify-start sm:gap-2 sm:px-2.5",
        )}
        aria-haspopup="dialog"
        aria-label={editor ? t("header.search") : undefined}
        onClick={onSearch}
      >
        <Search aria-hidden="true" />
        <span
          className={cn(
            editor
              ? "sr-only"
              : "sr-only sm:not-sr-only sm:flex-1 sm:text-start",
          )}
        >
          {t("header.search")}
        </span>
        {/* i18n-ignore: keyboard shortcut glyphs, not language text */}
        {!editor && (
          <Kbd className="hidden shrink-0 sm:inline-flex">
            {shortcutLabel()}
          </Kbd>
        )}
      </Button>

      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="relative"
              aria-label={
                notifications.count
                  ? t("header.notificationsWithCount", {
                      count: notifications.count,
                    })
                  : t("header.notifications")
              }
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
              className="absolute -top-1 -end-1 h-4 min-w-4 justify-center px-1 text-[10px]"
              aria-hidden="true"
            >
              {/* i18n-ignore: badge overflow marker, not language text */}
              {notifications.count > 99 ? "99+" : notifications.count}
            </Badge>
          )}
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[min(24rem,calc(100vw-2rem))] gap-3 p-3"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">
              {t("header.notifications")}
            </h2>
            <span className="text-xs text-muted-foreground">
              {notifications.count
                ? t("header.activeCount", { count: notifications.count })
                : t("header.noneActive")}
            </span>
          </div>
          {notifications.count === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              {t("header.caughtUp")}
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
                const label = t(group.labelKey);
                return (
                  <section key={group.priority} aria-label={label}>
                    <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <Icon className="size-3.5" aria-hidden="true" />
                      {label}
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
      {editor && <div ref={slots?.setRight} className="contents" />}
      {accountMenu}
    </header>
  );
}
