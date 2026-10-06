import type { Screen, ScreenStatus } from "../../api/types";
import type { Incident } from "../../pages/ActivityIncidentShared";
import { isActivelyFailing } from "../../pages/ActivityIncidentShared";

/**
 * Why a screen is on the Needs attention list. Every reason is a fact the
 * server already reported: the computed status, a player-update error, or an
 * incident nobody has closed. The dashboard adds no thresholds of its own.
 */
export type AttentionReason =
  | { kind: "status"; status: "offline" | "stale" | "revoked" }
  | { kind: "updateFailed" }
  | { kind: "incident"; incidentType: string; severity: string };

export type AttentionItem = {
  screen: Screen;
  reasons: AttentionReason[];
};

/**
 * Statuses that mean a person may need to act. `recent` is a screen that just
 * lost its socket and is still inside the server's grace window, and
 * `disabled` is an administrator's own decision, so neither is a fault. Both
 * still appear in the fleet breakdown so nothing is hidden.
 */
const attentionStatuses = new Set<ScreenStatus>([
  "offline",
  "stale",
  "revoked",
]);

function statusRank(status: "offline" | "stale" | "revoked") {
  return status === "offline" ? 0 : status === "stale" ? 1 : 3;
}

function incidentRank(severity: string) {
  return severity === "critical" || severity === "error" ? 0 : 2;
}

function reasonRank(reason: AttentionReason) {
  switch (reason.kind) {
    case "status":
      return statusRank(reason.status);
    case "incident":
      return incidentRank(reason.severity);
    case "updateFailed":
      return 2;
  }
}

/**
 * Screens that need attention, most urgent first, each with the reasons that
 * put it there. Incidents describe playback, storage and safe-mode trouble
 * that the screen list cannot, so they are folded in per screen.
 *
 * A connectivity incident on a screen already listed as offline or stale, and
 * an update incident on a screen whose update error is already shown, say the
 * same thing twice and are dropped.
 */
export function deriveAttention(
  screens: Screen[],
  incidents: Incident[] = [],
): AttentionItem[] {
  const active = incidents.filter(isActivelyFailing);
  const items: AttentionItem[] = [];
  for (const screen of screens) {
    const reasons: AttentionReason[] = [];
    if (
      screen.status === "offline" ||
      screen.status === "stale" ||
      screen.status === "revoked"
    ) {
      reasons.push({ kind: "status", status: screen.status });
    }
    const hasUpdateError = Boolean(screen.updateError);
    if (hasUpdateError) reasons.push({ kind: "updateFailed" });
    for (const incident of active) {
      if (incident.primaryScreenId !== screen.id) continue;
      if (
        incident.incidentType === "connectivity" &&
        attentionStatuses.has(screen.status)
      ) {
        continue;
      }
      if (incident.incidentType === "update" && hasUpdateError) continue;
      const duplicate = reasons.some(
        (reason) =>
          reason.kind === "incident" &&
          reason.incidentType === incident.incidentType,
      );
      if (!duplicate) {
        reasons.push({
          kind: "incident",
          incidentType: incident.incidentType,
          severity: incident.severity,
        });
      }
    }
    if (reasons.length > 0) items.push({ screen, reasons });
  }
  return items
    .map((item) => ({
      ...item,
      reasons: [...item.reasons].sort((a, b) => reasonRank(a) - reasonRank(b)),
    }))
    .sort((a, b) => {
      const rank =
        reasonRank(a.reasons[0]!) - reasonRank(b.reasons[0]!) ||
        b.reasons.length - a.reasons.length;
      return rank || a.screen.name.localeCompare(b.screen.name);
    });
}

export type FleetSummary = {
  total: number;
  online: number;
  byStatus: Record<ScreenStatus, number>;
};

export function summarizeFleet(screens: Screen[]): FleetSummary {
  const byStatus: Record<ScreenStatus, number> = {
    online: 0,
    recent: 0,
    stale: 0,
    offline: 0,
    disabled: 0,
    revoked: 0,
    awaiting_player: 0,
  };
  for (const screen of screens) byStatus[screen.status] += 1;
  return { total: screens.length, online: byStatus.online, byStatus };
}

/**
 * Online screens that have content assigned. `nowPlayingName` is the assigned
 * playlist or layout, the same value the Screens table shows under "Now
 * playing": it names what a screen is set to show, not proof that the player
 * is showing it. Player-confirmed playback is counted separately from the
 * server's fleet health.
 */
export function onAirScreens(screens: Screen[]): Screen[] {
  return screens
    .filter((screen) => screen.status === "online" && screen.nowPlayingName)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Online screens with nothing assigned: reporting, but with nothing to show. */
export function idleScreenCount(screens: Screen[]): number {
  return screens.filter(
    (screen) => screen.status === "online" && !screen.nowPlayingName,
  ).length;
}
