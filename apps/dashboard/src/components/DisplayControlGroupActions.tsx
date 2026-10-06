import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { DisplayControlGroupPreview } from "../api/types";
import { apiErrorMessage } from "../i18n";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { ButtonGroup } from "./ui/button-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "./ui/item";
import { Skeleton } from "./ui/skeleton";
import { toast } from "./ui/toast";

type GroupDisplayCommand = DisplayControlGroupPreview["commandType"];

const powerCommands = [
  { commandType: "display_power_on", labelKey: "groupctl.actions.powerOn" },
  { commandType: "display_power_off", labelKey: "groupctl.actions.powerOff" },
] as const satisfies { commandType: GroupDisplayCommand; labelKey: string }[];
const muteCommands = [
  { commandType: "display_mute", labelKey: "groupctl.actions.mute" },
  { commandType: "display_unmute", labelKey: "groupctl.actions.unmute" },
] as const satisfies { commandType: GroupDisplayCommand; labelKey: string }[];

const dialogTitleKeys = {
  display_power_on: "groupctl.dialog.powerOnTitle",
  display_power_off: "groupctl.dialog.powerOffTitle",
  display_mute: "groupctl.dialog.muteTitle",
  display_unmute: "groupctl.dialog.unmuteTitle",
} as const satisfies Record<GroupDisplayCommand, string>;

const confirmKeys = {
  display_power_on: "groupctl.dialog.powerOnConfirm",
  display_power_off: "groupctl.dialog.powerOffConfirm",
  display_mute: "groupctl.dialog.muteConfirm",
  display_unmute: "groupctl.dialog.unmuteConfirm",
} as const satisfies Record<GroupDisplayCommand, string>;

/**
 * Group-wide display commands. Each command is an action: pressing it opens a
 * preview of exactly which displays will receive it, and the server-issued
 * fingerprint from that preview is what the confirmation applies.
 */
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
  const [pending, setPending] = useState<GroupDisplayCommand | null>(null);

  if (!manageable) return null;

  const renderButtons = (
    commands: readonly { commandType: GroupDisplayCommand; labelKey: string }[],
  ) =>
    commands.map((command) => (
      <Button
        key={command.commandType}
        type="button"
        variant="outline"
        size="sm"
        disabled={memberCount === 0}
        onClick={() => setPending(command.commandType)}
      >
        {t(command.labelKey as "groupctl.actions.powerOn")}
      </Button>
    ));

  return (
    <section className="grid gap-4">
      <header className="grid gap-1">
        <h2 className="text-base font-semibold">{t("groupctl.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("groupctl.body")}</p>
      </header>
      {memberCount === 0 ? (
        <p className="text-sm text-muted-foreground">{t("groupctl.empty")}</p>
      ) : (
        <div
          className="flex flex-wrap gap-3"
          role="group"
          aria-label={t("groupctl.groupLabel")}
        >
          <ButtonGroup>{renderButtons(powerCommands)}</ButtonGroup>
          <ButtonGroup>{renderButtons(muteCommands)}</ButtonGroup>
        </div>
      )}
      {pending && (
        <CommandDialog
          key={pending}
          groupId={groupId}
          commandType={pending}
          csrfToken={csrfToken}
          onClose={() => setPending(null)}
        />
      )}
    </section>
  );
}

function CommandDialog({
  groupId,
  commandType,
  csrfToken,
  onClose,
}: {
  groupId: string;
  commandType: GroupDisplayCommand;
  csrfToken: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const queryClient = useQueryClient();
  const preview = useQuery({
    queryKey: ["display-control-group", groupId, commandType],
    queryFn: () => api.displayControlGroupPreview(groupId, commandType),
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
      toast.add({
        title: t("groupctl.queued", {
          count: result.queuedCount,
          failed:
            result.failedCount > 0
              ? t("groupctl.queuedFailed", { count: result.failedCount })
              : "",
        }),
        type: result.failedCount ? "warning" : "success",
      });
      await queryClient.invalidateQueries({
        queryKey: ["display-control-group", groupId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["screen-reliability"],
      });
      onClose();
    },
  });

  const data = preview.data;
  const destructive = commandType === "display_power_off";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !apply.isPending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(dialogTitleKeys[commandType])}</DialogTitle>
          <DialogDescription>
            {data
              ? t("groupctl.dialog.summary", {
                  selected: data.selectedCount,
                  eligible: data.eligibleCount,
                })
              : t("groupctl.checking")}
          </DialogDescription>
        </DialogHeader>
        {preview.isLoading && <Skeleton className="h-24 w-full" />}
        {preview.error && (
          <Alert variant="destructive">
            <AlertDescription>
              {apiErrorMessage(preview.error)}
            </AlertDescription>
          </Alert>
        )}
        {data && (
          <>
            {data.unsupportedCount > 0 && (
              <p className="text-sm text-muted-foreground">
                {t("groupctl.unsupported", { count: data.unsupportedCount })}
              </p>
            )}
            <ItemGroup
              render={<ul />}
              className="max-h-64 gap-1 overflow-y-auto"
            >
              {data.screens.map((screen) => (
                <li key={screen.screenId}>
                  <Item size="xs" variant="outline">
                    <ItemContent>
                      <ItemTitle>{screen.name}</ItemTitle>
                    </ItemContent>
                    <ItemDescription className="m-0 line-clamp-none text-end">
                      {screen.eligible
                        ? t("groupctl.dialog.supported")
                        : (screen.reason ??
                          (screen.supported
                            ? t("groupctl.dialog.unavailable")
                            : t("groupctl.dialog.notSupported")))}
                    </ItemDescription>
                  </Item>
                </li>
              ))}
            </ItemGroup>
          </>
        )}
        {apply.error && (
          <Alert variant="destructive">
            <AlertDescription>{apiErrorMessage(apply.error)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={apply.isPending}
            onClick={onClose}
          >
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={apply.isPending || !data || data.eligibleCount === 0}
            onClick={() => apply.mutate()}
          >
            {apply.isPending
              ? t("detail.sending")
              : t(confirmKeys[commandType], {
                  count: data?.eligibleCount ?? 0,
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
