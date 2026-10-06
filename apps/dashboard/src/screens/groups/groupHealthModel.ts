import type { TFunction } from "i18next";
import type { Screen, ScreenStatus } from "../../api/types";
import { screenNeedsAttention } from "../fleet/fleetModel";
import type { GroupHealth } from "./displayGroupModel";

type ScreensT = TFunction<"screens", undefined>;

export type HealthPart = { text: string; attention: boolean };

/**
 * The health clause that follows a screen count. Emphasis belongs to
 * attention alone: "all online" and "2 online" stay quiet.
 */
export function healthParts(
  health: GroupHealth,
  t: ScreensT,
  options: { withOnlineCount?: boolean } = {},
): HealthPart[] {
  if (!health.known || health.total === 0) return [];
  const parts: HealthPart[] = [];
  if (health.attention === 0) {
    if (health.online === health.total)
      parts.push({ text: t("groups.health.allOnline"), attention: false });
    else if (health.online > 0)
      parts.push({
        text: t("groups.health.online", { count: health.online }),
        attention: false,
      });
    return parts;
  }
  if (options.withOnlineCount && health.online > 0)
    parts.push({
      text: t("groups.health.online", { count: health.online }),
      attention: false,
    });
  parts.push({
    text: t("groups.health.attention", { count: health.attention }),
    attention: true,
  });
  return parts;
}

/** Plain-text form for descriptions and accessible names. */
export function healthSentence(
  health: GroupHealth,
  t: ScreensT,
  options: { withOnlineCount?: boolean } = {},
) {
  if (health.total === 0) return t("groups.health.noScreens");
  return [
    t("groups.count", { count: health.total }),
    ...healthParts(health, t, options).map((part) => part.text),
  ].join(" · ");
}

export const screenStatusKeys = {
  online: "status.online",
  recent: "status.recent",
  stale: "status.stale",
  offline: "status.offline",
  disabled: "status.disabled",
  revoked: "status.revoked",
} as const satisfies Record<ScreenStatus, string>;

/** Fleet's vocabulary: anything Fleet flags reads "Needs attention". */
export function screenStatusText(screen: Screen | undefined, t: ScreensT) {
  if (!screen) return t("shared.unknown");
  return screenNeedsAttention(screen)
    ? t("status.attention")
    : t(screenStatusKeys[screen.status]);
}
