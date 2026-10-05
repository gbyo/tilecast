import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  CircleAlert,
  Clock,
  HardDrive,
  RefreshCw,
  ShieldAlert,
  ShieldOff,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "../ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../ui/item";
import type { AttentionItem, AttentionReason } from "./attention";
import { formatLastContact } from "./format";
import { HeaderLink } from "./HeaderLink";
import { Skeleton } from "../ui/skeleton";
import { listBleed, railRowsSkeleton, rowBleed, titleRow } from "./layout";

const MAX_ROWS = 8;

type ReasonKey =
  | "statusLabels.offline"
  | "statusLabels.stale"
  | "statusLabels.revoked"
  | "operations.reasons.updateFailed"
  | "operations.reasons.incident.connectivity"
  | "operations.reasons.incident.playback"
  | "operations.reasons.incident.storage"
  | "operations.reasons.incident.safe_mode"
  | "operations.reasons.incident.update"
  | "operations.reasons.incident.other";

const incidentKeys: Record<string, ReasonKey> = {
  connectivity: "operations.reasons.incident.connectivity",
  playback: "operations.reasons.incident.playback",
  storage: "operations.reasons.incident.storage",
  safe_mode: "operations.reasons.incident.safe_mode",
  update: "operations.reasons.incident.update",
};

export function reasonKey(reason: AttentionReason): ReasonKey {
  switch (reason.kind) {
    case "status":
      return `statusLabels.${reason.status}`;
    case "updateFailed":
      return "operations.reasons.updateFailed";
    case "incident":
      return (
        incidentKeys[reason.incidentType] ?? "operations.reasons.incident.other"
      );
  }
}

function reasonVariant(reason: AttentionReason) {
  if (reason.kind === "incident") {
    return reason.severity === "critical" || reason.severity === "error"
      ? ("destructive" as const)
      : ("secondary" as const);
  }
  if (reason.kind === "status" && reason.status === "revoked") {
    return "outline" as const;
  }
  return "destructive" as const;
}

/**
 * Screens that need a person, with the reason for each, in one neutral Card.
 * Severity lives on the rows (an icon for the most urgent reason and a badge
 * per reason), never on the Card. Renders nothing when there is nothing to report and incident data
 * is complete: a healthy fleet says so once, in the fleet status above, and
 * gives the space back.
 */
export function NeedsAttention({
  items,
  incidentsFailed,
}: {
  items: AttentionItem[];
  incidentsFailed: boolean;
}) {
  const { t } = useTranslation("activity");
  if (items.length === 0) {
    // No heading to claim a problem exists: the only thing to say is that the
    // list may be incomplete.
    return incidentsFailed ? (
      <Alert>
        <CircleAlert aria-hidden="true" />
        <AlertDescription>
          {t("operations.attention.incidentsUnavailable")}
        </AlertDescription>
      </Alert>
    ) : null;
  }
  const shown = items.slice(0, MAX_ROWS);
  return (
    <Card
      size="sm"
      role="region"
      aria-labelledby="attention-heading"
      className="gap-2 pb-3"
    >
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle
            id="attention-heading"
            role="heading"
            aria-level={2}
            className={titleRow}
          >
            {t("operations.attention.title")}
          </CardTitle>
        </div>
        <CardAction className="self-center">
          <HeaderLink to="/screens" label={t("operations.attention.viewAll")} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {incidentsFailed && (
          <Alert>
            <CircleAlert aria-hidden="true" />
            <AlertDescription>
              {t("operations.attention.incidentsUnavailable")}
            </AlertDescription>
          </Alert>
        )}
        <ItemGroup className={listBleed}>
          {shown.map(({ screen, reasons }) => {
            const showContact = reasons.some(
              (reason) => reason.kind === "status",
            );
            const location = screen.location || t("operations.noLocation");
            // Reasons arrive most urgent first, so the first one picks the icon.
            const primary = reasons[0]!;
            const Icon = reasonIcon(primary);
            return (
              <Item
                key={screen.id}
                size="xs"
                render={<Link to={`/screens/${screen.id}`} />}
                className={`${rowBleed} grid min-h-13 grid-cols-[1rem_minmax(0,1fr)_1rem] gap-x-3 gap-y-1 py-2 not-first:shadow-[inset_0_1px_0_0_var(--color-border)] sm:grid-cols-[1rem_minmax(0,1fr)_auto_1rem]`}
              >
                <ItemMedia variant="icon" className="text-muted-foreground">
                  <Icon aria-hidden="true" />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="max-w-full">{screen.name}</ItemTitle>
                  <ItemDescription className="line-clamp-1">
                    {showContact
                      ? t("operations.lastContact", {
                          location,
                          relative: formatLastContact(screen.lastContactAt),
                        })
                      : location}
                  </ItemDescription>
                </ItemContent>
                <ul className="col-start-2 flex flex-wrap gap-1 max-sm:row-start-2 sm:col-start-3 sm:row-start-1 sm:justify-end">
                  {reasons.map((reason) => {
                    const key = reasonKey(reason);
                    return (
                      <li key={key}>
                        <Badge variant={reasonVariant(reason)}>{t(key)}</Badge>
                      </li>
                    );
                  })}
                </ul>
                <ItemActions className="col-start-3 row-start-1 sm:col-start-4">
                  <ChevronRight
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
        {items.length > MAX_ROWS && (
          <Link
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            to="/screens"
          >
            {t("operations.attention.more", {
              count: items.length - MAX_ROWS,
            })}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Held while the list loads so the cards below do not drop when it arrives.
 * It shows no title: a fleet with nothing to report never gets the section, and
 * a heading that then vanishes would read as a false alarm.
 */
export function NeedsAttentionSkeleton() {
  const { t } = useTranslation("activity");
  return (
    <div role="status" aria-label={t("operations.attention.loading")}>
      <Card size="sm" className="gap-2 pb-3">
        <CardHeader>
          <div className={titleRow}>
            <Skeleton className="h-4 w-32" />
          </div>
        </CardHeader>
        <CardContent>
          <div className={railRowsSkeleton}>
            <Skeleton className="h-13 w-full max-sm:h-[4.9rem]" />
            <Skeleton className="h-13 w-full max-sm:h-[4.9rem]" />
            <Skeleton className="h-13 w-full max-sm:h-[4.9rem]" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const incidentIcons: Record<string, LucideIcon> = {
  connectivity: WifiOff,
  playback: CircleAlert,
  storage: HardDrive,
  safe_mode: ShieldAlert,
  update: RefreshCw,
};

function reasonIcon(reason: AttentionReason): LucideIcon {
  switch (reason.kind) {
    case "status":
      return reason.status === "offline"
        ? WifiOff
        : reason.status === "stale"
          ? Clock
          : ShieldOff;
    case "updateFailed":
      return RefreshCw;
    case "incident":
      return incidentIcons[reason.incidentType] ?? CircleAlert;
  }
}
