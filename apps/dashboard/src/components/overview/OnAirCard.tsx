import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { Screen } from "../../api/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader } from "../ui/empty";
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

const MAX_ROWS = 5;

/**
 * What online screens are set to show. The value comes from the screen's
 * assigned playlist or layout, the same one the Screens table lists under
 * "Now playing", so this says what is assigned, not that the Player has
 * confirmed it is on the display. Confirmed playback is the "Playing" figure
 * in the fleet status.
 */
export function OnAirCard({
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
  const shown = onAir.slice(0, MAX_ROWS);
  const hidden = onAir.length - shown.length;
  return (
    <Card size="sm" role="region" aria-labelledby="on-air-heading">
      <CardHeader>
        <CardTitle id="on-air-heading" role="heading" aria-level={2}>
          {t("operations.onAir.title")}
        </CardTitle>
        <CardDescription>{t("operations.onAir.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div
            role="status"
            aria-label={t("operations.onAir.loading")}
            className="grid gap-2"
          >
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : shown.length === 0 ? (
          <Empty className="border-0 p-2">
            <EmptyHeader>
              <EmptyDescription>
                {online === 0
                  ? t("operations.onAir.noneOnline")
                  : t("operations.onAir.noneAssigned")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-0.5">
            {shown.map((screen) => (
              <Item
                key={screen.id}
                size="sm"
                render={<Link to={`/screens/${screen.id}`} />}
                className="min-h-11 px-2"
              >
                <ItemContent className="min-w-0">
                  <ItemTitle className="max-w-full">{screen.name}</ItemTitle>
                  <ItemDescription className="line-clamp-1">
                    {t(
                      screen.nowPlayingType === "playlist"
                        ? "operations.onAir.playlist"
                        : "operations.onAir.presentation",
                      { name: screen.nowPlayingName },
                    )}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <ChevronRight
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
        {!isLoading && (hidden > 0 || (idle > 0 && onAir.length > 0)) && (
          <p className="text-xs text-muted-foreground">
            {hidden > 0 && (
              <Link
                className="underline underline-offset-4 hover:text-foreground"
                to="/screens"
              >
                {t("operations.onAir.more", { count: hidden })}
              </Link>
            )}
            {hidden > 0 && idle > 0 && " "}
            {idle > 0 && t("operations.onAir.unassigned", { count: idle })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
