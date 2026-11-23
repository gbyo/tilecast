import { CORE_EVENTS } from "@tilecast/plugin-sdk/events";
import { useTranslation } from "react-i18next";

type CoreEvent = (typeof CORE_EVENTS)[number];

/** Translation keys of the closed core vocabulary. */
const coreKeys = {
  "screen.status.changed@1": "screenStatusChanged",
  "takeover.started@1": "takeoverStarted",
  "takeover.ended@1": "takeoverEnded",
  "takeover.suspended@1": "takeoverSuspended",
  "incident.opened@1": "incidentOpened",
  "incident.recovered@1": "incidentRecovered",
  "schedule.changed@1": "scheduleChanged",
  "feed.stale@1": "feedStale",
} as const satisfies Record<CoreEvent, string>;

export function isCoreEvent(event: string): event is CoreEvent {
  return (CORE_EVENTS as readonly string[]).includes(event);
}

/** Reasons a subscription is inactive that Studio explains. */
export const knownInactiveReasons = [
  "publisher_unknown",
  "publisher_not_installed",
  "event_not_declared",
  "no_own_feeds",
] as const;

/**
 * Words for events. A core event is named by what happens in Tilecast; a
 * plugin event by its full name, which carries the publisher's ID.
 */
export function useEventLabels() {
  const { t } = useTranslation("plugins");
  return {
    /** What a core event reports, or undefined for a plugin event. */
    core: (event: string) =>
      isCoreEvent(event)
        ? t(`hosted.events.core.${coreKeys[event]}`)
        : undefined,
    /** Who publishes an event: Tilecast, or a named plugin and its ID. */
    publisher: (publisher: string, name?: string) =>
      publisher === "core"
        ? t("hosted.events.publisher.core")
        : name
          ? t("hosted.events.publisher.plugin", { name, id: publisher })
          : t("hosted.events.publisher.unknown", { id: publisher }),
  };
}
