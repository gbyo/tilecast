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
import { idleScreenCount, onAirScreens } from "./attention";
import { listBleed, rowBleed } from "./layout";
import { LoadReveal } from "./LoadReveal";
import { RailSection } from "./RailSection";

const MAX_ROWS = 4;

/** Online screens grouped by the content they are set to show. */
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
 * What online screens are set to show, one row per piece of content with the
 * screens showing it. The value comes from each screen's assigned playlist or
 * layout, the same one the Screens table lists under "Now playing", so this
 * says what is assigned, not that the Player has confirmed it is on the
 * display. Confirmed playback is the "Playing" figure in the fleet status.
 */
export function OnAirSection({
  screens,
  isLoading,
}: {
  screens: Screen[];
  isLoading: boolean;
}) {
  const { t } = useTranslation("activity");
  const onAir = onAirScreens(screens);
  const idle = idleScreenCount(screens);
  const online = onAir.length + idle;
  const groups = groupByContent(onAir);
  const shown = groups.slice(0, MAX_ROWS);
  const hidden = groups.length - shown.length;
  return (
    <RailSection id="on-air-heading" title={t("operations.onAir.title")}>
      <LoadReveal
        loading={isLoading}
        className="grid gap-2"
        skeleton={
          <div
            role="status"
            aria-label={t("operations.onAir.loading")}
            className="grid gap-1.5"
          >
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        }
      >
        {shown.length === 0 ? (
          <p className="py-1 text-sm text-muted-foreground">
            {online === 0
              ? t("operations.onAir.noneOnline")
              : t("operations.onAir.noneAssigned")}
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
                    {t("operations.onAir.screenCount", {
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
        {onAir.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {[
              t("operations.onAir.footer", {
                assigned: onAir.length,
                unassigned: idle,
              }),
              hidden > 0
                ? t("operations.onAir.moreGroups", { count: hidden })
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
