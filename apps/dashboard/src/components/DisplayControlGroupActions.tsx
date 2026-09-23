import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import type { DisplayControlGroupPreview } from "../api/types";
import { Alert, AlertDescription } from "./ui/alert";
import { Button as RheaButton } from "./ui/button";

type GroupDisplayCommand = DisplayControlGroupPreview["commandType"];

const actions: { commandType: GroupDisplayCommand; label: string }[] = [
  { commandType: "display_power_on", label: "Power on all" },
  { commandType: "display_power_off", label: "Power off all" },
  { commandType: "display_mute", label: "Mute all" },
  { commandType: "display_unmute", label: "Unmute all" },
];

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
        `${result.queuedCount} command${result.queuedCount === 1 ? "" : "s"} queued${result.failedCount ? ` · ${result.failedCount} failed` : ""}.`,
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
        <h3 className="text-base font-semibold">Display Control</h3>
        <p className="text-sm text-muted-foreground">
          Preview capability coverage before sending a bounded action to every
          supported display in this group. Player connectivity remains separate
          from display power state.
        </p>
      </header>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Display Group actions"
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
            {action.label}
          </RheaButton>
        ))}
      </div>
      {memberCount === 0 ? (
        <p className="text-sm text-muted-foreground">
          Add screens before using group Display Control.
        </p>
      ) : preview.isLoading ? (
        <p className="text-sm text-muted-foreground">
          Checking reported capabilities…
        </p>
      ) : preview.error ? (
        <Alert variant="destructive">
          <AlertDescription>{preview.error.message}</AlertDescription>
        </Alert>
      ) : data ? (
        <>
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <strong>{data.selectedCount} displays selected</strong>
            <span className="text-muted-foreground">
              {data.supportedCount} support {capability} control
            </span>
            {data.unsupportedCount > 0 && (
              <span className="text-muted-foreground">
                {data.unsupportedCount} unsupported
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
              {data.eligibleCount} eligible command
              {data.eligibleCount === 1 ? "" : "s"} · capability snapshot
              refreshes automatically
            </span>
            <RheaButton
              type="button"
              disabled={apply.isPending || data.eligibleCount === 0}
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? "Sending…" : "Send to supported displays"}
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
