import { useMemo } from "react";
import type { AuthStatus } from "../api/types";
import { useAuth } from "./AuthProvider";

/**
 * The capability vocabulary. The server owns it (apps/server/internal/auth/
 * capabilities.go) and reports each account's effective capabilities in the
 * auth status; Studio only asks whether one is present. Studio never maps a
 * role name to authority, so a custom role works without Studio knowing it.
 *
 * Hiding a control is a convenience. Every API route makes its own decision.
 */
export const capabilityKeys = [
  "media.read",
  "media.upload",
  "media.edit",
  "media.organize",
  "media.tags.assign",
  "media.archive",
  "media.delete",
  "media.folders.manage",
  "media.tags.manage",
  "media.collections.manage",
  "widget.read",
  "widget.edit",
  "widget.delete",
  "datasource.read",
  "datasource.edit",
  "datasource.manage",
  "playlist.read",
  "playlist.edit",
  "playlist.publish",
  "playlist.delete",
  "layout.read",
  "layout.edit",
  "layout.publish",
  "layout.delete",
  "campaign.read",
  "campaign.edit",
  "campaign.publish",
  "content.review",
  "screen.read",
  "screen.manage",
  "screen.pair",
  "screen.assign",
  "schedule.read",
  "schedule.edit",
  "activity.read",
  "activity.audit",
  "activity.manage",
  "plugins.use",
  "plugins.manage",
  "users.manage",
  "roles.manage",
  "settings.manage",
  "system.manage",
  "system.backups",
  "integrations.manage",
  "player.releases",
] as const;

export type Capability = (typeof capabilityKeys)[number];

/** The capabilities an auth status reports. */
export function capabilitySet(status?: AuthStatus): ReadonlySet<string> {
  return new Set(
    status?.authenticated === false ? [] : (status?.capabilities ?? []),
  );
}

/** Whether an auth status grants capability. */
export function hasCapability(
  status: AuthStatus | undefined,
  capability: Capability,
): boolean {
  return capabilitySet(status).has(capability);
}

export type Capabilities = {
  /** The account's role grants capability. */
  can: (capability: Capability) => boolean;
  /** The account's role grants at least one of capabilities. */
  canAny: (...capabilities: readonly Capability[]) => boolean;
  /** The account is the built-in Owner, which only identity checks need. */
  isOwner: boolean;
};

export function capabilitiesFrom(status?: AuthStatus): Capabilities {
  const set = capabilitySet(status);
  return {
    can: (capability) => set.has(capability),
    canAny: (...capabilities) =>
      capabilities.some((capability) => set.has(capability)),
    isOwner: status?.user?.role === "owner",
  };
}

/** The signed-in account's capabilities. */
export function useCapabilities(): Capabilities {
  const auth = useAuth();
  const status = auth.status;
  return useMemo(() => capabilitiesFrom(status), [status]);
}

/**
 * A route or control requirement: every group must be satisfied, and a group
 * is satisfied by any one of its capabilities. Route trees accumulate one
 * group per level, so a child never escapes its parent's requirement.
 */
export type CapabilityRequirement = readonly (readonly Capability[])[];

export function requirementMet(
  requirement: CapabilityRequirement,
  capabilities: Pick<Capabilities, "canAny">,
): boolean {
  return requirement.every(
    (group) => group.length === 0 || capabilities.canAny(...group),
  );
}
