import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { DisplayControlGroupPreview } from "../api/types";
import { Alert, AlertDescription } from "./ui/alert";
import { Button as RheaButton } from "./ui/button";

type GroupDisplayCommand = DisplayControlGroupPreview["commandType"];

const actions = [
  { commandType: "display_power_on", labelKey: "groupctl.actions.powerOn" },
  { commandType: "display_power_off", labelKey: "groupctl.actions.powerOff" },
  { commandType: "display_mute", labelKey: "groupctl.actions.mute" },
  { commandType: "display_unmute", labelKey: "groupctl.actions.unmute" },
] as const satisfies { commandType: GroupDisplayCommand; labelKey: string }[];

function actionCapability(commandType: GroupDisplayCommand) {
  return commandType.includes("power") ? "power" : "mute";
}

export function DisplayControlGroupActions({
  groupId,
  memberCount,
  manageable,
  csrfToken,
}: {
  groupId: string;
  memberCount: number;
  manageable: boolean;
  csrfToken: string;
}) {
  const { t } = useTranslation("screens");
  const queryClient = useQueryClient();
  const [commandType, setCommandType] =
    useState<GroupDisplayCommand>("display_power_on");
  const [lastResult, setLastResult] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: ["display-control-group", groupId, commandType],
    queryFn: () => api.displayControlGroupPreview(groupId, commandType),
    enabled: manageable && memberCount > 0,
    refetchInterval: 10_000,
  });
  const apply = useMutation({
    mutationFn: () =>
      api.applyDisplayControlGroup(
        groupId,
        commandType,
        preview.data?.fingerprint ?? "",
        csrfToken,
      ),
    onSuccess: async (result) => {
      setLastResult(
        t("groupctl.queued", {
          count: result.queuedCount,
          failed:
            result.failedCount > 0
              ? t("groupctl.queuedFailed", { count: result.failedCount })
              : "",
        }),
      );
      await queryClient.invalidateQueries({
        queryKey: ["display-control-group", groupId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["screen-reliability"],
      });
    },
  });

  if (!manageable) return null;

  const data = preview.data;
  const capability = actionCapability(commandType);
  return (
    <section className="grid gap-3 rounded-xl border border-border p-4">
      <header className="grid gap-1">
        <h3 className="text-base font-semibold">{t("groupctl.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("groupctl.body")}</p>
      </header>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={t("groupctl.groupLabel")}
      >
        {actions.map((action) => (
          <RheaButton
            key={action.commandType}
            type="button"
            variant={
              commandType === action.commandType ? "default" : "secondary"
            }
            size="sm"
            onClick={() => {
              setCommandType(action.commandType);
              setLastResult(null);
            }}
          >
            {t(action.labelKey)}
          </RheaButton>
        ))}
      </div>
      {memberCount === 0 ? (
        <p className="text-sm text-muted-foreground">{t("groupctl.empty")}</p>
      ) : preview.isLoading ? (
        <p className="text-sm text-muted-foreground">
          {t("groupctl.checking")}
        </p>
      ) : preview.error ? (
        <Alert variant="destructive">
          <AlertDescription>{preview.error.message}</AlertDescription>
        </Alert>
      ) : data ? (
        <>
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <strong>
              {t("groupctl.selected", { count: data.selectedCount })}
            </strong>
            <span className="text-muted-foreground">
              {capability === "power"
                ? t("groupctl.supportPower", { count: data.supportedCount })
                : t("groupctl.supportMute", { count: data.supportedCount })}
            </span>
            {data.unsupportedCount > 0 && (
              <span className="text-muted-foreground">
                {t("groupctl.unsupported", { count: data.unsupportedCount })}
              </span>
            )}
          </p>
          {data.screens.some((screen) => screen.reason) && (
            <ul className="grid gap-1 text-sm">
              {data.screens
                .filter((screen) => screen.reason)
                .map((screen) => (
                  <li key={screen.screenId} className="flex flex-wrap gap-x-2">
                    <strong>{screen.name}</strong>
                    <span className="text-muted-foreground">
                      {screen.reason}
                    </span>
                  </li>
                ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">
              {t("groupctl.eligible", { count: data.eligibleCount })}
            </span>
            <RheaButton
              type="button"
              disabled={apply.isPending || data.eligibleCount === 0}
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? t("detail.sending") : t("groupctl.send")}
            </RheaButton>
          </div>
          {lastResult && (
            <Alert>
              <AlertDescription>{lastResult}</AlertDescription>
            </Alert>
          )}
          {apply.error && (
            <Alert variant="destructive">
              <AlertDescription>{apply.error.message}</AlertDescription>
            </Alert>
          )}
        </>
      ) : null}
    </section>
  );
}
