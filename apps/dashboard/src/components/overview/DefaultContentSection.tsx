import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { Screen } from "../../api/types";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../ui/item";
import { Skeleton } from "../ui/skeleton";
import {
  defaultContentScreens,
  noDefaultContentScreenCount,
} from "./attention";
import { listBleed, railRowsSkeleton, rowBleed } from "./layout";
import { LoadReveal } from "./LoadReveal";
import { RailSection } from "./RailSection";

const MAX_ROWS = 4;

/** Online screens grouped by their configured default fallback content. */
function groupByContent(screens: Screen[]) {
  const groups = new Map<string, { name: string; screens: Screen[] }>();
  for (const screen of screens) {
    const key = `${screen.nowPlayingType}:${screen.nowPlayingName}`;
    const group = groups.get(key);
    if (group) group.screens.push(screen);
    else
      groups.set(key, { name: screen.nowPlayingName ?? "", screens: [screen] });
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...group }))
    .sort(
      (a, b) =>
        b.screens.length - a.screens.length || a.name.localeCompare(b.name),
    );
}

/**
 * Default fallback content for online screens. This intentionally does not
 * claim what is on air: schedules, Show Now, and Takeover can override this
 * configuration, while Activity is authoritative for confirmed playback.
 */
export function DefaultContentSection({
  screens,
  isLoading,
}: {
  screens: Screen[];
  isLoading: boolean;
}) {
  const { t } = useTranslation("activity");
  const assignedDefaults = assignedDefaultsScreens(screens);
  const withoutDefault = withoutDefaultScreenCount(screens);
  const online = assignedDefaults.length + withoutDefault;
  const groups = groupByContent(assignedDefaults);
  const shown = groups.slice(0, MAX_ROWS);
  const hidden = groups.length - shown.length;
  return (
    <RailSection id="default-content-heading" title={t("operations.assignedDefaults.title")}>
      <LoadReveal
        loading={isLoading}
        className="grid gap-2"
        skeleton={
          <div
            role="status"
            aria-label={t("operations.assignedDefaults.loading")}
            className="grid gap-2"
          >
            <div className={railRowsSkeleton}>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
            <Skeleton className="h-4 w-44" />
          </div>
        }
      >
        {shown.length === 0 ? (
          <p className="py-1 text-sm text-muted-foreground">
            {online === 0
              ? t("operations.assignedDefaults.noneOnline")
              : t("operations.assignedDefaults.noneAssigned")}
          </p>
        ) : (
          <ItemGroup className={listBleed}>
            {shown.map((group) => (
              <Item
                key={group.key}
                size="xs"
                render={<Link to="/screens" />}
                className={rowBleed}
              >
                <ItemContent className="min-w-0">
                  <ItemTitle className="max-w-full">{group.name}</ItemTitle>
                  <ItemDescription className="line-clamp-1">
                    {group.screens.map((screen) => screen.name).join(", ")}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t("operations.assignedDefaults.screenCount", {
                      count: group.screens.length,
                    })}
                  </span>
                  <ChevronRight
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
        {assignedDefaults.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {[
              t("operations.assignedDefaults.footer", {
                assigned: assignedDefaults.length,
                unassigned: withoutDefault,
              }),
              hidden > 0
                ? t("operations.assignedDefaults.moreGroups", { count: hidden })
                : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </LoadReveal>
    </RailSection>
  );
}
