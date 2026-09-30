import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, CircleAlert } from "lucide-react";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../ui/item";
import type { AttentionItem, AttentionReason } from "./attention";
import { formatLastContact } from "./format";

const MAX_ROWS = 5;

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
 * Screens that need a person, with the reason for each. Renders nothing when
 * there is nothing to report and incident data is complete: a healthy fleet
 * says so once, in the fleet status above, and gives the space back.
 */
export function NeedsAttentionCard({
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
      className="ring-destructive/30"
    >
      <CardHeader>
        <CardTitle id="attention-heading" role="heading" aria-level={2}>
          {t("operations.attention.title")}
        </CardTitle>
        <CardDescription>
          {t("operations.attention.description")}
        </CardDescription>
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
        {shown.length > 0 && (
          <ItemGroup className="gap-0.5">
            {shown.map(({ screen, reasons }) => {
              const showContact = reasons.some(
                (reason) => reason.kind === "status",
              );
              const location = screen.location || t("operations.noLocation");
              return (
                <Item
                  key={screen.id}
                  size="sm"
                  render={<Link to={`/screens/${screen.id}`} />}
                  className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 px-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
                >
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
                  <ul className="col-span-2 flex flex-wrap gap-1 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:justify-end">
                    {reasons.map((reason) => {
                      const key = reasonKey(reason);
                      return (
                        <li key={key}>
                          <Badge variant={reasonVariant(reason)}>
                            {t(key)}
                          </Badge>
                        </li>
                      );
                    })}
                  </ul>
                  <ItemActions className="col-start-2 row-start-1 sm:col-start-3">
                    <ChevronRight
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        )}
        {items.length > MAX_ROWS && (
          <p className="text-xs text-muted-foreground">
            {t("operations.attention.more", { count: items.length - MAX_ROWS })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
