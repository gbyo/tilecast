import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { ScreenGroup } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { AirPlayPresentDialog } from "../../components/AirPlayPresentDialog";
import { QuickPresentDialog } from "../../components/QuickPresentDialog";
import { ActionMenuButton } from "../../components/studio/ActionMenu";
import { Button } from "../../components/ui/button";
import { DisplayGroupDialog } from "./DisplayGroupDialog";
import { healthSentence } from "./groupHealthModel";
import { groupFallback, type GroupHealth } from "./displayGroupModel";
import { useDeleteDisplayGroup } from "./useDeleteDisplayGroup";
import { useDisplayGroupAirPlayCapabilities } from "./useDisplayGroupAirPlayCapabilities";

/**
 * Name, quiet metadata, and the group's actions. Show now and AirPlay are the
 * frequent ones; edit and delete live in the overflow menu. It owns the
 * dialogs those actions open.
 */
export function DisplayGroupHeader({
  group,
  health,
  manageable,
}: {
  group: ScreenGroup;
  health: GroupHealth;
  manageable: boolean;
}) {
  const { t } = useTranslation("screens");
  const navigate = useNavigate();
  const csrf = useAuth().status?.csrfToken ?? "";
  const [airplayOpen, setAirplayOpen] = useState(false);
  const [quickPresentOpen, setQuickPresentOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const deletion = useDeleteDisplayGroup(() => void navigate("/groups"));
  const airplay = useDisplayGroupAirPlayCapabilities(group.screens);

  const fallback = groupFallback(group);
  const metadata = [
    healthSentence({ ...health, known: false }, t),
    group.displayMode === "span"
      ? t("groups.detail.modeSpan")
      : t("groups.detail.modeMirror"),
    fallback
      ? t("groups.detail.fallbackMeta", {
          type: t(`groups.fallbackType.${fallback.kind}`),
          name: fallback.name,
        })
      : null,
  ].filter(Boolean);

  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid min-w-0 gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{group.name}</h1>
        <p className="text-sm text-muted-foreground">
          {group.description || t("groups.detail.descriptionFallback")}
        </p>
        <p className="text-sm text-muted-foreground">{metadata.join(" · ")}</p>
      </div>
      {manageable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setQuickPresentOpen(true)}
          >
            {t("groups.detail.showNow")}
          </Button>
          <Button type="button" onClick={() => setAirplayOpen(true)}>
            {t("groups.detail.present")}
          </Button>
          <ActionMenuButton
            label={t("groups.detail.moreActions")}
            actions={[
              {
                actions: [
                  {
                    id: "edit",
                    label: t("groups.actions.edit"),
                    onSelect: () => setEditOpen(true),
                  },
                ],
              },
              {
                actions: [
                  {
                    id: "delete",
                    label: t("groups.detail.delete"),
                    role: "destructive",
                    onSelect: () => void deletion.requestDelete(group),
                  },
                ],
              },
            ]}
          />
        </div>
      )}

      <AirPlayPresentDialog
        open={airplayOpen}
        targetType="group"
        targetId={group.id}
        destinationName={group.name}
        displayCount={group.membershipCount}
        csrfToken={csrf}
        capabilities={airplay.capabilities}
        capabilityLoading={airplay.loading}
        capabilityError={airplay.error}
        audioDisplayName={
          group.presentationGatewayScreenId
            ? group.screens.find(
                (screen) => screen.id === group.presentationGatewayScreenId,
              )?.name
            : t("groups.detail.audioAutomatic")
        }
        onClose={() => setAirplayOpen(false)}
      />
      <QuickPresentDialog
        open={quickPresentOpen}
        targetType="group"
        targetId={group.id}
        destinationName={group.name}
        csrfToken={csrf}
        onClose={() => setQuickPresentOpen(false)}
      />
      {editOpen && (
        <DisplayGroupDialog open group={group} onOpenChange={setEditOpen} />
      )}
      {deletion.dialog}
    </header>
  );
}
