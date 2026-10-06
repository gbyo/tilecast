import { useTranslation } from "react-i18next";
import type { Screen, ScreenGroup } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/tabs";
import { PlayerPolicyEditor } from "../../settings/PlayerPolicyEditor";
import { DiscardChangesDialog } from "./DiscardChangesDialog";
import { DisplayGroupDisplay } from "./DisplayGroupDisplay";
import { DisplayGroupOverview } from "./DisplayGroupOverview";
import { DisplayGroupPlayback } from "./DisplayGroupPlayback";
import { DisplayGroupScreens } from "./DisplayGroupScreens";
import type { GroupHealth } from "./displayGroupModel";
import { useDisplayGroupTabNavigation } from "./useDisplayGroupTabNavigation";

/**
 * The detail sections as URL-backed line tabs. Leaving the Display or Player
 * policy tab with unsaved edits asks first.
 */
export function DisplayGroupTabs({
  group,
  health,
  inventory,
  manageable,
  csrfToken,
  onAddScreens,
}: {
  group: ScreenGroup;
  health: GroupHealth;
  inventory: ReadonlyMap<string, Screen> | undefined;
  manageable: boolean;
  csrfToken: string;
  onAddScreens: () => void;
}) {
  const { t } = useTranslation("screens");
  const navigation = useDisplayGroupTabNavigation();
  const { tab, selectTab } = navigation;
  const policyDirty = navigation.promptSection === "policy";

  return (
    <>
      <Tabs
        value={tab}
        onValueChange={selectTab}
        className="w-full min-w-0 gap-4"
      >
        <TabsList
          aria-label={t("groups.detail.tabsLabel")}
          variant="line"
          className="min-h-10 w-full justify-start gap-4 overflow-x-auto rounded-none border-b border-border p-0"
        >
          <TabsTrigger value="overview" className="flex-none px-2">
            {t("groups.detail.tabOverview")}
          </TabsTrigger>
          <TabsTrigger value="members" className="flex-none px-2">
            {t("groups.detail.tabMembers")}
          </TabsTrigger>
          <TabsTrigger value="content" className="flex-none px-2">
            {t("groups.detail.tabContent")}
          </TabsTrigger>
          <TabsTrigger value="display" className="flex-none px-2">
            {t("groups.detail.tabDisplay")}
          </TabsTrigger>
          <TabsTrigger value="policy" className="flex-none px-2">
            {t("groups.detail.tabPolicy")}{" "}
            {navigation.policyUnsaved && (
              <Badge variant="secondary">
                {t("groups.detail.unsavedBadge")}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {tab === "overview" && (
          <TabsContent value="overview" className="min-w-0 outline-none">
            <DisplayGroupOverview
              group={group}
              health={health}
              manageable={manageable}
              onNavigate={selectTab}
              onAddScreens={() => {
                selectTab("members");
                onAddScreens();
              }}
            />
          </TabsContent>
        )}
        {tab === "members" && (
          <TabsContent value="members" className="min-w-0 outline-none">
            <DisplayGroupScreens
              group={group}
              inventory={inventory}
              manageable={manageable}
              onAddScreens={onAddScreens}
            />
          </TabsContent>
        )}
        {tab === "content" && (
          <TabsContent value="content" className="min-w-0 outline-none">
            <DisplayGroupPlayback group={group} manageable={manageable} />
          </TabsContent>
        )}
        {tab === "display" && (
          <TabsContent value="display" className="min-w-0 outline-none">
            <DisplayGroupDisplay
              group={group}
              manageable={manageable}
              csrfToken={csrfToken}
              onDirtyChange={navigation.reportDisplayDirty}
            />
          </TabsContent>
        )}
        {tab === "policy" && (
          <TabsContent value="policy" className="min-w-0 outline-none">
            <PlayerPolicyEditor
              target="group"
              id={group.id}
              onDirtyChange={navigation.reportPolicyDirty}
            />
          </TabsContent>
        )}
      </Tabs>

      <DiscardChangesDialog
        open={navigation.promptSection !== null}
        title={
          policyDirty
            ? t("groups.detail.discardTitle")
            : t("groups.detail.discardWallTitle")
        }
        description={
          policyDirty
            ? t("groups.detail.discardBody")
            : t("groups.detail.discardWallBody")
        }
        onKeepEditing={navigation.keepEditing}
        onDiscard={navigation.discard}
      />
    </>
  );
}
