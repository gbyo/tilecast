import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthProvider";
import { translateKnown } from "../i18n";
import { formatWhen, humanize, ResultBadge } from "./ActivityShared";
import { screenActivityLink } from "./activityLinks";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

export type IncidentStatus =
  "open" | "acknowledged" | "recovered" | "resolved" | "ignored";

export type Incident = {
  id: string;
  incidentType: string;
  severity: string;
  status: IncidentStatus;
  title: string;
  description: string;
  openedAt: string;
  lastSeenAt: string;
  recoveredAt?: string;
  resolvedAt?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  assignedTo?: string;
  assignedToName?: string;
  primaryScreenId?: string;
  primaryScreenName?: string;
  locationName?: string;
  groupName?: string;
  deviceModel?: string;
  playerVersion?: string;
  affectedScreens: number;
  failureCode?: string;
  probableCause?: string;
  recoveryMode?: string;
  resolutionReason?: string;
  resolutionNotes?: string;
  occurrenceCount: number;
};

/** An incident nobody has closed and whose condition has not ended. */
export function isActivelyFailing(incident: Incident): boolean {
  return incident.status === "open" || incident.status === "acknowledged";
}

/**
 * Actions available for a status. A closed incident can only be reopened, and
 * a recovered one counts as closed: the condition ended by itself, so it is
 * history to read rather than work to sign off.
 */
// Action structures hold translation keys, never rendered text. Labels are
// resolved with t() at render so rows follow language changes.
export function actionsFor(status: IncidentStatus): {
  action: string;
  labelKey:
    | "incidents.actions.acknowledge"
    | "incidents.actions.resolve"
    | "incidents.actions.ignore"
    | "incidents.actions.reopen";
}[] {
  switch (status) {
    case "open":
      return [
        { action: "acknowledge", labelKey: "incidents.actions.acknowledge" },
        { action: "resolve", labelKey: "incidents.actions.resolve" },
        { action: "ignore", labelKey: "incidents.actions.ignore" },
      ];
    case "acknowledged":
      return [
        { action: "resolve", labelKey: "incidents.actions.resolve" },
        { action: "ignore", labelKey: "incidents.actions.ignore" },
      ];
    default:
      return [{ action: "reopen", labelKey: "incidents.actions.reopen" }];
  }
}

/**
 * How long the incident has been a problem. For something still failing this
 * is time so far and keeps growing; for a recovered one it is how long the
 * outage lasted. Describing a finished outage as ongoing would overstate it.
 */
export function incidentDuration(incident: Incident, now = Date.now()): string {
  const ended = incident.recoveredAt ?? incident.resolvedAt;
  const end = ended ? Date.parse(ended) : now;
  return formatElapsed(Math.max(0, end - Date.parse(incident.openedAt)));
}

export function formatElapsed(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 1)
    return translateKnown("activity:incidents.underMinute", "under a minute");
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The scope an incident affects: a screen, or a wider set of them. */
export function IncidentScope({ incident }: { incident: Incident }) {
  const { t } = useTranslation("activity");
  if (incident.affectedScreens > 1) {
    return (
      <span>
        {t("incidents.scopeScreens", { count: incident.affectedScreens })}
      </span>
    );
  }
  if (!incident.primaryScreenId)
    return <span>{t("incidents.scopeFleet")}</span>;
  return (
    <Link to={screenActivityLink(incident.primaryScreenId)}>
      {incident.primaryScreenName || t("incidents.scopeFallback")}
    </Link>
  );
}

/** Applies an operator action, with the CSRF token the API requires. */
export function useIncidentAction() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      action: string;
      reason?: string;
      notes?: string;
      assignedTo?: string;
    }) => {
      const response = await fetch(`/api/v1/activity/incidents/${input.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": auth.status?.csrfToken ?? "",
        },
        body: JSON.stringify({
          action: input.action,
          reason: input.reason,
          notes: input.notes,
          assignedTo: input.assignedTo,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(
          body.error?.message ??
            translateKnown(
              "activity:incidents.actionFailed",
              "The action could not be applied.",
            ),
        );
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["activity", "incidents"] }),
  });
}

export function useCanActOnIncidents(): boolean {
  const auth = useAuth();
  return ["owner", "administrator"].includes(auth.status?.user?.role ?? "");
}

export function IncidentStatusBadge({ incident }: { incident: Incident }) {
  const variant =
    incident.status === "open"
      ? "destructive"
      : incident.status === "acknowledged"
        ? "default"
        : "secondary";
  return <Badge variant={variant}>{humanize(incident.status)}</Badge>;
}

/**
 * One incident row. Everything an operator needs to triage is on the row
 * itself — severity, scope, what happened, how long, status, when it was last
 * seen, whether it recovered, and who owns it — with the evidence behind a
 * disclosure so the list stays scannable.
 */
export function IncidentRow({
  incident,
  actions,
  detail,
  onOpenDetail,
}: {
  incident: Incident;
  actions?: ReactNode;
  detail?: ReactNode;
  /** When set, the row defers to a drawer instead of expanding in place. */
  onOpenDetail?: (incident: Incident) => void;
}) {
  const { t } = useTranslation("activity");
  const [expanded, setExpanded] = useState(false);
  const recovered = incident.recoveredAt;

  return (
    <li className="grid gap-2 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <ResultBadge value={incident.severity} />
            <strong className="text-sm">{incident.title}</strong>
          </span>
          <small className="text-xs text-muted-foreground">
            {incident.description}
          </small>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <IncidentStatusBadge incident={incident} />
            <IncidentScope incident={incident} />
            {incident.locationName && <span>{incident.locationName}</span>}
            <span>
              {/* Ongoing versus how long it lasted: a recovered incident is
                  not still costing anyone a screen. */}
              {isActivelyFailing(incident)
                ? t("incidents.ongoingFor", {
                    duration: incidentDuration(incident),
                  })
                : t("incidents.lastedFor", {
                    duration: incidentDuration(incident),
                  })}
            </span>
            <span>
              {t("incidents.lastSeenAt", {
                when: formatWhen(incident.lastSeenAt),
              })}
            </span>
            {recovered && (
              <span>
                {incident.recoveryMode === "automatic"
                  ? t("incidents.recoveredAuto", {
                      when: formatWhen(recovered),
                    })
                  : t("incidents.recoveredPlain", {
                      when: formatWhen(recovered),
                    })}
              </span>
            )}
            {incident.occurrenceCount > 1 && (
              <span>
                {t("incidents.occurrences", {
                  count: incident.occurrenceCount,
                })}
              </span>
            )}
            {incident.assignedToName && (
              <span>
                {t("incidents.assignedTo", { name: incident.assignedToName })}
              </span>
            )}
          </div>
        </div>
        <div className="grid shrink-0 justify-items-end gap-1">
          <time
            dateTime={incident.openedAt}
            className="text-xs text-muted-foreground tabular-nums"
          >
            {formatWhen(incident.openedAt)}
          </time>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={onOpenDetail ? undefined : expanded}
            onClick={() =>
              onOpenDetail
                ? onOpenDetail(incident)
                : setExpanded((current) => !current)
            }
          >
            {t("incidents.details")}
          </Button>
        </div>
      </div>
      {!onOpenDetail && expanded && (
        <div className="grid gap-2 border-t border-border pt-2">
          {detail ?? <IncidentFacts incident={incident} />}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
    </li>
  );
}

/** The established facts about an incident, and only the established ones. */
export function IncidentFacts({ incident }: { incident: Incident }) {
  const { t } = useTranslation("activity");
  return (
    <dl className="grid gap-1.5 text-sm sm:grid-cols-2 [&_div]:flex [&_div]:flex-wrap [&_div]:gap-x-2 [&_dt]:shrink-0 [&_dt]:text-muted-foreground">
      <div>
        <dt>{t("incidents.facts.cause")}</dt>
        {/* Never invent one. An empty cause says so plainly rather than
            offering a guess to an operator as fact. */}
        <dd>{incident.probableCause || t("incidents.facts.unknownCause")}</dd>
      </div>
      <div>
        <dt>{t("incidents.facts.opened")}</dt>
        <dd>{formatWhen(incident.openedAt)}</dd>
      </div>
      <div>
        <dt>{t("incidents.facts.lastSeen")}</dt>
        <dd>{formatWhen(incident.lastSeenAt)}</dd>
      </div>
      {incident.recoveredAt && (
        <div>
          <dt>{t("incidents.facts.recovered")}</dt>
          <dd>
            {formatWhen(incident.recoveredAt)}
            {incident.recoveryMode === "automatic"
              ? t("incidents.recoveredModeAuto")
              : t("incidents.recoveredModeManual")}
          </dd>
        </div>
      )}
      {incident.acknowledgedAt && (
        <div>
          <dt>{t("incidents.facts.acknowledged")}</dt>
          <dd>
            {formatWhen(incident.acknowledgedAt)}
            {incident.acknowledgedBy
              ? t("incidents.acknowledgedBy", {
                  name: incident.acknowledgedBy,
                })
              : ""}
          </dd>
        </div>
      )}
      {incident.resolvedAt && (
        <div>
          <dt>{t("incidents.facts.resolved")}</dt>
          <dd>
            {formatWhen(incident.resolvedAt)}
            {incident.resolutionReason
              ? t("incidents.resolvedReason", {
                  reason: incident.resolutionReason,
                })
              : ""}
          </dd>
        </div>
      )}
      {incident.failureCode && (
        <div>
          <dt>{t("incidents.facts.failureCode")}</dt>
          <dd>{incident.failureCode}</dd>
        </div>
      )}
      {incident.deviceModel && (
        <div>
          <dt>{t("incidents.facts.deviceModel")}</dt>
          <dd>{incident.deviceModel}</dd>
        </div>
      )}
      {incident.playerVersion && (
        <div>
          <dt>{t("incidents.facts.playerVersion")}</dt>
          <dd>{incident.playerVersion}</dd>
        </div>
      )}
      {incident.resolutionNotes && (
        <div>
          <dt>{t("incidents.facts.notes")}</dt>
          <dd>{incident.resolutionNotes}</dd>
        </div>
      )}
    </dl>
  );
}

export function IncidentActionButtons({
  incident,
  onAct,
  pending,
}: {
  incident: Incident;
  onAct: (action: string) => void;
  pending: boolean;
}) {
  const { t } = useTranslation("activity");
  return (
    <>
      {actionsFor(incident.status).map((item) => (
        <Button
          key={item.action}
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => onAct(item.action)}
        >
          {t(item.labelKey)}
        </Button>
      ))}
    </>
  );
}
