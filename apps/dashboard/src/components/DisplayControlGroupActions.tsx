import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import type { DisplayControlGroupPreview } from "../api/types";
import { Button, Panel, SectionHeader } from "./legacy-ui";
import "./DisplayControlGroupActions.css";

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
    <Panel className="display-control-group-actions">
      <SectionHeader
        title="Display Control"
        description="Preview capability coverage before sending a bounded action to every supported display in this group. Player connectivity remains separate from display power state."
      />
      <div
        className="display-control-group-actions__buttons"
        role="group"
        aria-label="Display Group actions"
      >
        {actions.map((action) => (
          <Button
            key={action.commandType}
            variant={
              commandType === action.commandType ? "primary" : "secondary"
            }
            compact
            onClick={() => {
              setCommandType(action.commandType);
              setLastResult(null);
            }}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {memberCount === 0 ? (
        <p className="field__hint">
          Add screens before using group Display Control.
        </p>
      ) : preview.isLoading ? (
        <p className="field__hint">Checking reported capabilities…</p>
      ) : preview.error ? (
        <div className="notice notice--error" role="alert">
          {preview.error.message}
        </div>
      ) : data ? (
        <>
          <p className="display-control-group-actions__summary">
            <strong>{data.selectedCount} displays selected</strong>
            <span>
              {data.supportedCount} support {capability} control
            </span>
            {data.unsupportedCount > 0 && (
              <span>{data.unsupportedCount} unsupported</span>
            )}
          </p>
          {data.screens.some((screen) => screen.reason) && (
            <ul className="display-control-group-actions__details">
              {data.screens
                .filter((screen) => screen.reason)
                .map((screen) => (
                  <li key={screen.screenId}>
                    <strong>{screen.name}</strong>
                    <span>{screen.reason}</span>
                  </li>
                ))}
            </ul>
          )}
          <div className="display-control-group-actions__footer">
            <span className="field__hint">
              {data.eligibleCount} eligible command
              {data.eligibleCount === 1 ? "" : "s"} · capability snapshot
              refreshes automatically
            </span>
            <Button
              variant="primary"
              loading={apply.isPending}
              disabled={apply.isPending || data.eligibleCount === 0}
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? "Sending…" : "Send to supported displays"}
            </Button>
          </div>
          {lastResult && (
            <div className="notice notice--success">{lastResult}</div>
          )}
          {apply.error && (
            <div className="notice notice--error" role="alert">
              {apply.error.message}
            </div>
          )}
        </>
      ) : null}
    </Panel>
  );
}
