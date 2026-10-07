import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  AppWindow,
  Box,
  Clock,
  Database,
  Globe,
  HardDrive,
  LayoutPanelTop,
  Puzzle,
} from "lucide-react";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../../components/ui/item";
import type { CapabilityRow, ContributionRow } from "./detailView";

const noClamp = "line-clamp-none";

type KnownContribution = "widget" | "dataSource" | "plugin";

const contributionKinds: Record<
  string,
  { icon: ComponentType<{ className?: string }>; key: KnownContribution }
> = {
  widget: { icon: LayoutPanelTop, key: "widget" },
  dataSource: { icon: Database, key: "dataSource" },
  plugin: { icon: Puzzle, key: "plugin" },
};

/**
 * One thing a package adds, by what it is rather than where its files sit.
 * Exact paths and ids live under Technical details.
 */
export function ContributionItem({
  row,
  tone = "default",
}: {
  row: ContributionRow;
  /** Update review marks what changed. */
  tone?: "default" | "added" | "removed";
}) {
  const { t } = useTranslation("plugins");
  const known = contributionKinds[row.kind];
  const Icon = known?.icon ?? Box;
  return (
    <Item
      variant="muted"
      size="sm"
      render={<li />}
      data-tone={tone === "default" ? undefined : tone}
    >
      <ItemMedia variant="icon">
        <Icon aria-hidden="true" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{row.name}</ItemTitle>
        <ItemDescription className={noClamp}>
          <span className="block text-xs font-medium text-foreground/70">
            {known ? t(`storeDetail.kinds.${known.key}`) : row.kind}
          </span>
          <span className="block">
            {known
              ? t(`storeDetail.kindDescriptions.${known.key}`)
              : t("storeDetail.kindDescriptions.other")}
          </span>
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

const capabilityIcons = {
  network: Globe,
  storage: HardDrive,
  background: Clock,
  studioUI: AppWindow,
} as const;

/**
 * One reviewed capability in plain language. Background activity names how
 * many jobs run, not their schedule: the Background jobs section owns that
 * operational detail once the package is installed.
 */
export function CapabilityItem({ row }: { row: CapabilityRow }) {
  const { t } = useTranslation("plugins");
  const Icon = capabilityIcons[row.kind];
  return (
    <Item variant="muted" size="sm" render={<li />}>
      <ItemMedia variant="icon">
        <Icon aria-hidden="true" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{t(`storeDetail.capabilities.${row.kind}.title`)}</ItemTitle>
        {row.kind === "network" && (
          <ItemDescription className={noClamp}>
            <span className="block">
              {t("storeDetail.capabilities.network.body")}
            </span>
            {row.hosts.map((host) => (
              <span
                key={host}
                className="block font-mono text-xs text-foreground/80"
              >
                {host}
              </span>
            ))}
          </ItemDescription>
        )}
        {row.kind === "storage" && (
          <ItemDescription className={noClamp}>
            {t("storeDetail.capabilities.storage.body")}
          </ItemDescription>
        )}
        {row.kind === "studioUI" && (
          <ItemDescription className={noClamp}>
            {t("storeDetail.capabilities.studioUI.body")}
          </ItemDescription>
        )}
        {row.kind === "background" && (
          <ItemDescription className={noClamp}>
            {t("storeDetail.capabilities.background.body", {
              count: row.jobs.length,
            })}
          </ItemDescription>
        )}
      </ItemContent>
    </Item>
  );
}
