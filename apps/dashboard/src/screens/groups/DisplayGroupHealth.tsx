import { CircleAlert, ShieldOff, Wifi, WifiOff } from "lucide-react";
import type { TFunction } from "i18next";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import type { Screen, ScreenStatus } from "../../api/types";
import { screenNeedsAttention } from "../fleet/fleetModel";
import type { GroupHealth } from "./displayGroupModel";

type ScreensT = TFunction<"screens", undefined>;

type HealthPart = { text: string; attention: boolean };

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

/** "3 screens · 2 online · 1 needs attention" as inline text. */
export function GroupHealthText({
  health,
  withOnlineCount = false,
}: {
  health: GroupHealth;
  withOnlineCount?: boolean;
}) {
  const { t } = useTranslation("screens");
  if (health.total === 0) return <span>{t("groups.health.noScreens")}</span>;
  const parts = healthParts(health, t, { withOnlineCount });
  return (
    <span>
      {t("groups.count", { count: health.total })}
      {parts.map((part) => (
        <Fragment key={part.text}>
          {" · "}
          {part.attention ? (
            <span className="font-medium text-destructive">{part.text}</span>
          ) : (
            part.text
          )}
        </Fragment>
      ))}
    </span>
  );
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

const statusIcons: Record<ScreenStatus, typeof Wifi> = {
  online: Wifi,
  recent: Wifi,
  stale: CircleAlert,
  offline: WifiOff,
  disabled: ShieldOff,
  revoked: ShieldOff,
};

const statusKeys = {
  online: "status.online",
  recent: "status.recent",
  stale: "status.stale",
  offline: "status.offline",
  disabled: "status.disabled",
  revoked: "status.revoked",
} as const satisfies Record<ScreenStatus, string>;

/**
 * One member's state in Fleet's vocabulary. Anything Fleet would flag reads
 * "Needs attention", with the precise reason underneath. Text always
 * accompanies the icon so color is never the only signal.
 */
export function ScreenHealthStatus({ screen }: { screen?: Screen }) {
  const { t } = useTranslation("screens");
  if (!screen)
    return <span className="text-muted-foreground">{t("shared.unknown")}</span>;
  const attention = screenNeedsAttention(screen);
  const Icon = attention ? CircleAlert : statusIcons[screen.status];
  const detail =
    screen.status === "online" && screen.updateError
      ? t("shared.updateFailed")
      : t(statusKeys[screen.status]);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon
        aria-hidden="true"
        className={
          attention
            ? "size-4 shrink-0 text-destructive"
            : "size-4 shrink-0 text-muted-foreground"
        }
      />
      <span className="grid min-w-0">
        <span className={attention ? "font-medium" : undefined}>
          {attention ? t("status.attention") : t(statusKeys[screen.status])}
        </span>
        {attention && (
          <span className="text-xs text-muted-foreground">{detail}</span>
        )}
      </span>
    </span>
  );
}

export function screenStatusText(screen: Screen | undefined, t: ScreensT) {
  if (!screen) return t("shared.unknown");
  return screenNeedsAttention(screen)
    ? t("status.attention")
    : t(statusKeys[screen.status]);
}
