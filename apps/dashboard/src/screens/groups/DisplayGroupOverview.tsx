import { ChevronRight, Layers, MonitorPlay, Tv } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ScreenGroup } from "../../api/types";
import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "../../components/ui/item";
import { healthSentence } from "./DisplayGroupHealth";
import type { GroupDetailTab, GroupHealth } from "./displayGroupModel";
import { groupFallback } from "./displayGroupModel";

/**
 * An at-a-glance view where every row opens the tab that owns the setting. A
 * group with no screens gets the next step instead of rows of "None".
 */
export function DisplayGroupOverview({
  group,
  health,
  manageable,
  onNavigate,
  onAddScreens,
}: {
  group: ScreenGroup;
  health: GroupHealth;
  manageable: boolean;
  onNavigate: (tab: GroupDetailTab) => void;
  onAddScreens: () => void;
}) {
  const { t } = useTranslation("screens");
  const fallback = groupFallback(group);

  if (group.membershipCount === 0)
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Tv aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{t("groups.overview.setupTitle")}</EmptyTitle>
          <EmptyDescription>
            {t("groups.overview.setupDescription")}
          </EmptyDescription>
        </EmptyHeader>
        {manageable && (
          <EmptyContent>
            <Button type="button" onClick={onAddScreens}>
              {t("groups.detail.addScreens")}
            </Button>
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => onNavigate("content")}
            >
              {t("groups.overview.configureFallback")}
            </Button>
          </EmptyContent>
        )}
      </Empty>
    );

  const rows: {
    tab: GroupDetailTab;
    icon: typeof Tv;
    title: string;
    description: string;
  }[] = [
    {
      tab: "members",
      icon: Tv,
      title: t("groups.detail.screensLabel"),
      description: healthSentence(health, t, { withOnlineCount: true }),
    },
    {
      tab: "content",
      icon: MonitorPlay,
      title: t("groups.overview.fallbackTitle"),
      description: fallback
        ? t("groups.overview.fallbackValue", {
            type: t(`groups.fallbackType.${fallback.kind}`),
            name: fallback.name,
          })
        : t("groups.overview.fallbackNone"),
    },
    {
      tab: "display",
      icon: Layers,
      title: t("groups.overview.modeTitle"),
      description:
        group.displayMode === "span"
          ? t("groups.overview.modeSpan")
          : t("groups.overview.modeMirror"),
    },
  ];

  return (
    <ItemGroup>
      {rows.map((row, index) => (
        <div key={row.tab} role="listitem">
          {index > 0 && <ItemSeparator className="my-0" />}
          <Item
            size="sm"
            render={<button type="button" />}
            onClick={() => onNavigate(row.tab)}
            className="w-full cursor-pointer text-start hover:bg-muted"
          >
            <ItemMedia variant="icon">
              <row.icon aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{row.title}</ItemTitle>
              <ItemDescription>{row.description}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <ChevronRight
                aria-hidden="true"
                className="size-4 text-muted-foreground rtl:rotate-180"
              />
            </ItemActions>
          </Item>
        </div>
      ))}
    </ItemGroup>
  );
}
