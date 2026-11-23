/**
 * Feeds of a Plugin Manifest API 3 plugin (docs/plugin-feeds.md). This file
 * mirrors packages/plugin-sdk/go/plugin/feeds_v3.go; the shared fixtures in
 * testdata/manifests keep the two in agreement.
 */
import {
  configSchemaProblems,
  type ConfigField,
} from "@tilecast/config-schema";

export const MAX_FEEDS = 8;
export const MAX_FEED_FIELDS = 16;
export const MAX_FEED_RECORDS = 2000;
export const MAX_FEED_RECORD_ID_LENGTH = 80;
export const MAX_FEED_PUBLICATION_BYTES = 512 * 1024;
export const MIN_FEED_REFRESH_SECONDS = 60;
export const MAX_FEED_REFRESH_SECONDS = 7 * 24 * 60 * 60;
export const MAX_FEED_VALUE_LENGTH = 4096;

export const FEED_CONTROLS = [
  "text",
  "multiline_text",
  "select",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "url",
] as const;

export const OVERRIDE_POLICIES = [
  "upstream",
  "local",
  "local_until_changed",
] as const;

export const feedIdPattern = /^[a-z][a-z0-9_]{0,39}$/;
export const feedProviderIdPattern =
  /^[a-z][a-z0-9_]{0,79}\.[a-z][a-z0-9_]{0,39}$/;

export interface FeedFieldDeclaration extends ConfigField {
  override?: (typeof OVERRIDE_POLICIES)[number];
  image?: { connection: string };
}

export interface FeedDeclaration {
  id: string;
  version: number;
  title: string;
  description?: string;
  dataset: "organization" | "instance";
  instanceKind?: string;
  expectedRefreshSeconds: number;
  fields: FeedFieldDeclaration[];
}

/** The Player Data Document type of a feed field. */
export function feedFieldDocumentType(field: FeedFieldDeclaration): string {
  if (field.image) return "asset";
  switch (field.control) {
    case "multiline_text":
    case "select":
      return "text";
    default:
      return field.control;
  }
}

/** Problems of the feeds of one manifest, beyond the JSON shape. */
export function feedProblems(manifest: {
  id: string;
  feeds?: readonly FeedDeclaration[];
  connections?: readonly { id: string }[];
  instances?: readonly { kind: string }[];
}): string[] {
  const problems: string[] = [];
  const feeds = manifest.feeds ?? [];
  const connections = new Set(
    (manifest.connections ?? []).map((item) => item.id),
  );
  const kinds = new Set((manifest.instances ?? []).map((item) => item.kind));
  const seen = new Set<string>();
  for (const feed of feeds) {
    const where = `feed "${feed.id}"`;
    if (seen.has(feed.id)) problems.push(`feed "${feed.id}" is declared twice`);
    seen.add(feed.id);
    const provider = `${manifest.id}.${feed.id}`;
    if (provider.length > 80 || !feedProviderIdPattern.test(provider))
      problems.push(
        `${where} has a Data Source provider identity longer than 80 characters`,
      );
    if (feed.dataset === "organization" && feed.instanceKind)
      problems.push(
        `${where} has an organization dataset and names an instance kind`,
      );
    if (feed.dataset === "instance" && !kinds.has(feed.instanceKind ?? ""))
      problems.push(
        `${where} has an instance dataset but names no declared instance kind`,
      );
    for (const field of feed.fields) {
      if (field.default !== undefined)
        problems.push(
          `${where} field "${field.key}" has a default; a publication supplies every value`,
        );
      if (field.image) {
        if (field.control !== "url")
          problems.push(
            `${where} field "${field.key}" is an image and must use the url control`,
          );
        if (!connections.has(field.image.connection))
          problems.push(
            `${where} field "${field.key}" imports images through connection "${field.image.connection}", which the manifest does not declare`,
          );
        if ((field.override ?? "upstream") !== "upstream")
          problems.push(
            `${where} field "${field.key}" is an image; images are always upstream`,
          );
        if (field.personal)
          problems.push(
            `${where} field "${field.key}" is an image and cannot be personal`,
          );
      }
      if (
        (field.control === "text" || field.control === "multiline_text") &&
        (!field.maxLength || field.maxLength > MAX_FEED_VALUE_LENGTH)
      )
        problems.push(
          `${where} field "${field.key}" needs a maxLength of at most ${MAX_FEED_VALUE_LENGTH}`,
        );
    }
    problems.push(
      ...configSchemaProblems(feed.fields as ConfigField[], "plugin").map(
        (problem) => `${where}: ${problem}`,
      ),
    );
  }
  return problems;
}
