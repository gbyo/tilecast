import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  AppWindow,
  Box,
  Clock,
  Database,
  Globe,
  HardDrive,
  KeyRound,
  LayoutPanelTop,
  Puzzle,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "../../components/ui/item";
import type { CapabilityRow, ContributionRow } from "./detailView";

const noClamp = "line-clamp-none";

/**
 * How a row sits on the page. `default` is an open list row: no fill, flush
 * with the section heading, and `separated` rows draw a hairline above them.
 * `muted` is the contained row the review surface uses, where each row
 * stands apart on its own.
 */
export type ItemRowVariant = "default" | "muted";

export type RowPresentation = {
  variant?: ItemRowVariant;
  /** Draws a separator above the row; only the `default` list uses it. */
  separated?: boolean;
};

const openRowClass = "px-0 py-3";

/** One `li` of a structured list; every Item row on the detail page uses it. */
export function ItemRow({
  variant = "default",
  separated = false,
  tone,
  status,
  children,
}: RowPresentation & {
  tone?: "added" | "removed";
  /** Marks a row whose state matters, such as a failed background job. */
  status?: "failed";
  children: ReactNode;
}) {
  return (
    <li>
      {separated && variant === "default" && <ItemSeparator className="my-0" />}
      <Item
        variant={variant}
        size="sm"
        data-tone={tone}
        data-status={status}
        className={variant === "default" ? openRowClass : undefined}
      >
        {children}
      </Item>
    </li>
  );
}

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
  tone,
  variant,
  separated,
}: RowPresentation & {
  row: ContributionRow;
  /** Update review marks what changed. */
  tone?: "added" | "removed";
}) {
  const { t } = useTranslation("plugins");
  const known = contributionKinds[row.kind];
  const Icon = known?.icon ?? Box;
  return (
    <ItemRow variant={variant} separated={separated} tone={tone}>
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
    </ItemRow>
  );
}

const capabilityIcons = {
  network: Globe,
  storage: HardDrive,
  background: Clock,
  studioUI: AppWindow,
  service: KeyRound,
} as const;

function serviceCategoryLabel(
  category: string,
  t: ReturnType<typeof useTranslation<"plugins">>["t"],
) {
  switch (category) {
    case "read":
      return t("storeDetail.capabilities.service.categories.read");
    case "directory":
      return t("storeDetail.capabilities.service.categories.directory");
    case "manage":
      return t("storeDetail.capabilities.service.categories.manage");
    case "audit":
      return t("storeDetail.capabilities.service.categories.audit");
    default:
      return category;
  }
}

/**
 * One reviewed capability in plain language. Background activity names how
 * many jobs run, not their schedule: the Background jobs section owns that
 * operational detail once the package is installed.
 */
export function CapabilityItem({
  row,
  variant,
  separated,
}: RowPresentation & { row: CapabilityRow }) {
  const { t } = useTranslation("plugins");
  const Icon = capabilityIcons[row.kind];
  return (
    <ItemRow variant={variant} separated={separated}>
      <ItemMedia variant="icon">
        <Icon aria-hidden="true" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {row.kind === "service"
            ? row.grant.name
            : t(`storeDetail.capabilities.${row.kind}.title`)}
        </ItemTitle>
        {row.kind === "service" && (
          <ItemDescription className={noClamp}>
            <span className="block text-xs font-medium text-foreground/70">
              {t("storeDetail.capabilities.service.version", {
                version: row.grant.version,
              })}{" "}
              · {serviceCategoryLabel(row.grant.category, t)}
            </span>
            <span className="block">{row.grant.description}</span>
            {row.grant.operations.map((operation) => (
              <span key={operation.name} className="block">
                {operation.mutating
                  ? t("storeDetail.capabilities.service.operationMutating", {
                      title: operation.title,
                    })
                  : operation.title}
              </span>
            ))}
          </ItemDescription>
        )}
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
    </ItemRow>
  );
}
