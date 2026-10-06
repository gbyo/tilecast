import { CircleAlert, ShieldOff, Wifi, WifiOff } from "lucide-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import type { Screen, ScreenStatus } from "../../api/types";
import { screenNeedsAttention } from "../fleet/fleetModel";
import { healthParts, screenStatusKeys } from "./groupHealthModel";
import type { GroupHealth } from "./displayGroupModel";

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

const statusIcons: Record<ScreenStatus, typeof Wifi> = {
  online: Wifi,
  recent: Wifi,
  stale: CircleAlert,
  offline: WifiOff,
  disabled: ShieldOff,
  revoked: ShieldOff,
};

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
      : t(screenStatusKeys[screen.status]);
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
          {attention
            ? t("status.attention")
            : t(screenStatusKeys[screen.status])}
        </span>
        {attention && (
          <span className="text-xs text-muted-foreground">{detail}</span>
        )}
      </span>
    </span>
  );
}
