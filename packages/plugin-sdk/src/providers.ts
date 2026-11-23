/**
 * Provider slots of a Plugin Manifest API 3 plugin
 * (docs/plugin-providers.md). This file mirrors
 * packages/plugin-sdk/go/plugin/providers_v3.go; the shared fixtures in
 * testdata/manifests keep the two in agreement.
 */

export const CONTENT_KINDS = [
  "playlist",
  "layout",
  "widget_instance",
  "media_item",
] as const;
export const MAX_NOTIFICATION_CHANNELS = 2;
export const MAX_CONTENT_CHECKS = 4;
export const providerIdPattern = /^[a-z][a-z0-9_]{0,39}$/;

export interface ProvidersDeclaration {
  notifications?: { channels: { id: string }[] };
  contentHealth?: { checks: { id: string; kinds: string[] }[] };
}

/** Problems of the providers of one manifest, beyond the JSON shape. */
export function providerProblems(manifest: {
  providers?: ProvidersDeclaration;
}): string[] {
  const problems: string[] = [];
  const channels = new Set<string>();
  for (const channel of manifest.providers?.notifications?.channels ?? []) {
    if (channels.has(channel.id))
      problems.push(`notification channel "${channel.id}" is declared twice`);
    channels.add(channel.id);
  }
  const checks = new Set<string>();
  for (const check of manifest.providers?.contentHealth?.checks ?? []) {
    if (checks.has(check.id))
      problems.push(`content check "${check.id}" is declared twice`);
    checks.add(check.id);
    const kinds = new Set<string>();
    for (const kind of check.kinds) {
      if (kinds.has(kind))
        problems.push(
          `content check "${check.id}" names item kind "${kind}" twice`,
        );
      kinds.add(kind);
    }
  }
  return problems;
}
