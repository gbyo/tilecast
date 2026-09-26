import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { Button } from "./ui/button";
import { toast } from "./ui/toast";

const ACCESSIBILITY_COMPONENT =
  "org.tilecast.player/org.tilecast.player.reliability.TilecastAccessibilityService";

export const fireTvAccessibilityCommands = (address?: string) => {
  const target = address
    ? address.includes(":")
      ? `[${address}]:5555`
      : `${address}:5555`
    : "FIRE_TV_IP:5555";
  const enable = `adb shell 'component="${ACCESSIBILITY_COMPONENT}"; current=$(settings get secure enabled_accessibility_services); [ "$current" = "null" ] && current=""; case ":$current:" in *":$component:"*) ;; *) current="\${current:+$current:}$component" ;; esac; settings put secure enabled_accessibility_services "$current"; settings put secure accessibility_enabled 1'`;
  return {
    connect: `adb connect ${target}`,
    enable,
    combined: `adb connect ${target}
${enable}`,
  };
};

export function isFireTvScreen(
  screen:
    | { platform?: string; deviceManufacturer?: string | null }
    | null
    | undefined,
) {
  return (
    screen?.platform === "fire-tv" ||
    screen?.deviceManufacturer?.toLowerCase() === "amazon"
  );
}

export function FireTvAccessibilityAdbPanel({
  screenId,
}: {
  screenId: string;
}) {
  const { t } = useTranslation("screens");
  const [showCommand, setShowCommand] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const screen = useQuery({
    queryKey: ["screens", screenId],
    queryFn: () => api.screen(screenId),
  });

  const isFireTv = isFireTvScreen(screen.data);
  const commands = useMemo(
    () => fireTvAccessibilityCommands(screen.data?.lastKnownIp),
    [screen.data?.lastKnownIp],
  );
  if (!isFireTv) return null;

  const copyCommands = async () => {
    try {
      await navigator.clipboard.writeText(commands.combined);
      setCopyState("copied");
      toast.add({ title: t("detail.fireTv.copiedNote"), type: "success" });
      window.setTimeout(() => setCopyState("idle"), 2_000);
    } catch {
      setCopyState("error");
      toast.add({
        title: t("detail.fireTv.copyFail"),
        type: "error",
      });
    }
  };

  const commandPanelId = `fire-tv-accessibility-commands-${screenId}`;
  return (
    <section
      className="space-y-3 border-t border-border pt-4"
      aria-labelledby="fire-tv-accessibility-title"
    >
      <div>
        <h3 id="fire-tv-accessibility-title" className="text-sm font-medium">
          {t("detail.fireTv.title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("detail.fireTv.body")}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        aria-expanded={showCommand}
        aria-controls={commandPanelId}
        onClick={() => {
          setShowCommand((shown) => !shown);
          setCopyState("idle");
        }}
      >
        {showCommand ? t("detail.fireTv.hide") : t("detail.fireTv.show")}
      </Button>
      {showCommand && (
        <div id={commandPanelId} className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("detail.fireTv.first")}
          </p>
          <pre className="overflow-x-auto rounded-xl border border-border bg-muted p-3 text-xs">
            <code>{commands.combined}</code>
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => void copyCommands()}
            >
              {copyState === "copied"
                ? t("detail.fireTv.copied")
                : t("detail.fireTv.copy")}
            </Button>
            <span
              role="status"
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >
              {copyState === "error"
                ? t("detail.fireTv.copyFail")
                : copyState === "copied"
                  ? t("detail.fireTv.copiedNote")
                  : ""}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("detail.fireTv.last")}
          </p>
        </div>
      )}
    </section>
  );
}