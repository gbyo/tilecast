/**
 * Server events of a Plugin Manifest API 3 plugin (docs/plugin-events.md).
 * This file mirrors packages/plugin-sdk/go/plugin/events_v3.go; the shared
 * fixtures in testdata/manifests keep the two in agreement.
 */
import {
  configSchemaProblems,
  type ConfigField,
} from "@tilecast/config-schema";

/** The closed core vocabulary. A manifest cannot name another core event. */
export const CORE_EVENTS = [
  "screen.status.changed@1",
  "takeover.started@1",
  "takeover.ended@1",
  "takeover.suspended@1",
  "incident.opened@1",
  "incident.recovered@1",
  "schedule.changed@1",
  "feed.stale@1",
] as const;

export const MAX_PUBLISHED_EVENTS = 16;
export const MAX_EVENT_SUBSCRIPTIONS = 32;
export const MAX_EVENT_FIELDS = 16;
export const MAX_EVENT_VERSION = 999;
export const MAX_EVENT_PAYLOAD_BYTES = 4096;
export const MAX_EVENT_SUBJECT_BYTES = 128;

export const serverEventNamePattern = /^[a-z][a-z0-9_]{0,39}$/;
export const pluginEventPattern =
  /^plugin\.([a-z][a-z0-9_]{0,79})\.([a-z][a-z0-9_]{0,39})@([1-9][0-9]{0,2})$/;

export interface PublishedEventDeclaration {
  name: string;
  version: number;
  title: string;
  description?: string;
  fields: ConfigField[];
}

export interface EventsDeclaration {
  publishes?: PublishedEventDeclaration[];
  subscribes?: string[];
}

/** The full name of a plugin event: plugin.<plugin>.<name>@<version>. */
export function pluginEventName(
  pluginId: string,
  name: string,
  version: number,
): string {
  return `plugin.${pluginId}.${name}@${version}`;
}

/** Problems of the events of one manifest, beyond the JSON shape. */
export function eventProblems(manifest: {
  events?: EventsDeclaration;
  services?: readonly string[];
}): string[] {
  const problems: string[] = [];
  const events = manifest.events;
  const publishes = events?.publishes ?? [];
  const declaresPublish = (manifest.services ?? []).some((service) =>
    service.startsWith("events.publish@"),
  );
  if (publishes.length > 0 !== declaresPublish)
    problems.push(
      "a plugin that publishes events declares events.publish@1, and only such a plugin does",
    );
  const seen = new Set<string>();
  for (const event of publishes) {
    const reference = `${event.name}@${event.version}`;
    if (seen.has(reference))
      problems.push(`event ${reference} is declared twice`);
    seen.add(reference);
    for (const problem of configSchemaProblems(event.fields, "event"))
      problems.push(`event ${reference} payload: ${problem}`);
  }
  const subscribed = new Set<string>();
  for (const name of events?.subscribes ?? []) {
    if (subscribed.has(name))
      problems.push(`event ${name} is subscribed twice`);
    subscribed.add(name);
    if ((CORE_EVENTS as readonly string[]).includes(name)) continue;
    if (pluginEventPattern.test(name)) continue;
    problems.push(
      name.startsWith("plugin.")
        ? `invalid plugin event name "${name}"; use plugin.<plugin id>.<name>@<version>`
        : `unknown core event "${name}"; core events are ${CORE_EVENTS.join(", ")}`,
    );
  }
  return problems;
}
