import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ApiError, api } from "../../api/client";
import type { ScreenGroup } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { apiErrorMessage } from "../../i18n";
import { AirPlayPresentDialog } from "../../components/AirPlayPresentDialog";
import { QuickPresentDialog } from "../../components/QuickPresentDialog";
import { ActionMenuButton } from "../../components/studio/ActionMenu";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button, buttonVariants } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Skeleton } from "../../components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/tabs";
import { SCREEN_STATUS_REFRESH_MS, screenQueries } from "../../data/screens";
import { PlayerPolicyEditor } from "../../settings/PlayerPolicyEditor";
import { AddScreensPicker } from "./AddScreensPicker";
import { DisplayGroupDialog } from "./DisplayGroupDialog";
import { DisplayGroupDisplay } from "./DisplayGroupDisplay";
import { healthSentence } from "./DisplayGroupHealth";
import { DisplayGroupOverview } from "./DisplayGroupOverview";
import { DisplayGroupPlayback } from "./DisplayGroupPlayback";
import { DisplayGroupScreens } from "./DisplayGroupScreens";
import {
  canManageGroups,
  groupDetailTabs,
  groupFallback,
  groupHealth,
  normalizeGroupDetailTab,
  screenInventory,
} from "./displayGroupModel";
import type { GroupDetailTab } from "./displayGroupModel";
import { useDeleteDisplayGroup } from "./useDeleteDisplayGroup";

export function DisplayGroupDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const manageable = canManageGroups(auth.status?.user?.role);
  const { t } = useTranslation(["screens", "common"]);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = normalizeGroupDetailTab(searchParams.get("tab"));
  const [airplayOpen, setAirplayOpen] = useState(false);
  const [quickPresentOpen, setQuickPresentOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [pendingDestination, setPendingDestination] =
    useState<GroupDetailTab | null>(null);
  const deletion = useDeleteDisplayGroup(() => void navigate("/groups"));

  const group = useQuery({
    queryKey: ["screen-groups", id],
    queryFn: () => api.screenGroup(id),
  });
  const inventoryQuery = useQuery({
    ...screenQueries.list(),
    refetchInterval: SCREEN_STATUS_REFRESH_MS,
  });
  const inventory = useMemo(
    () => screenInventory(inventoryQuery.data?.items),
    [inventoryQuery.data],
  );
  const groupAirplayQueries = useQueries({
    queries: (group.data?.screens ?? []).map((screen) => ({
      queryKey: ["screen-reliability", screen.id],
      queryFn: () => api.screenReliability(screen.id),
      refetchInterval: 10_000,
    })),
  });

  const commitDestination = (destination: GroupDetailTab) => {
    const next = new URLSearchParams(searchParams);
    if (destination === "overview") next.delete("tab");
    else next.set("tab", destination);
    setSearchParams(next);
    setPendingDestination(null);
    setPolicyDirty(false);
  };
  const selectTab = (nextTab: string) => {
    if (!groupDetailTabs.includes(nextTab as GroupDetailTab)) return;
    if (nextTab === tab) return;
    if (policyDirty && tab === "policy" && nextTab !== "policy") {
      setPendingDestination(nextTab as GroupDetailTab);
      return;
    }
    commitDestination(nextTab as GroupDetailTab);
  };

  if (group.isPending)
    return (
      <div className="grid gap-2" aria-label={t("groups.detail.loading")}>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  if (group.isError && !group.data) {
    const notFound =
      group.error instanceof ApiError &&
      group.error.status === 404 &&
      group.error.code === "schedule_not_found";
    return (
      <section className="grid max-w-xl gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {notFound
            ? t("groups.detail.notFoundTitle")
            : t("groups.detail.loadErrorTitle")}
        </h1>
        <Alert variant="destructive">
          <AlertDescription>
            {notFound
              ? t("groups.detail.notFoundBody")
              : t("groups.detail.loadErrorBody")}
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-2">
          {!notFound && (
            <Button type="button" onClick={() => void group.refetch()}>
              {t("common:actions.retry")}
            </Button>
          )}
          <Link to="/groups" className={buttonVariants({ variant: "outline" })}>
            {t("groups.detail.backToGroups")}
          </Link>
        </div>
      </section>
    );
  }
  if (!group.data) return null;

  const groupData: ScreenGroup = group.data;
  const health = groupHealth(groupData, inventory);
  const fallback = groupFallback(groupData);
  const metadata = [
    healthSentence({ ...health, known: false }, t),
    groupData.displayMode === "span"
      ? t("groups.detail.modeSpan")
      : t("groups.detail.modeMirror"),
    fallback
      ? t("groups.detail.fallbackMeta", {
          type: t(`groups.fallbackType.${fallback.kind}`),
          name: fallback.name,
        })
      : null,
  ].filter(Boolean);
  const failedAirplay = groupAirplayQueries.find((query) => query.error);
  const airplayError = failedAirplay?.error
    ? apiErrorMessage(failedAirplay.error)
    : undefined;
  const capabilities = groupAirplayQueries.flatMap((query) =>
    query.data ? [query.data] : [],
  );

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {groupData.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {groupData.description || t("groups.detail.descriptionFallback")}
          </p>
          <p className="text-sm text-muted-foreground">
            {metadata.join(" · ")}
          </p>
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
                      onSelect: () => void deletion.requestDelete(groupData),
                    },
                  ],
                },
              ]}
            />
          </div>
        )}
      </header>

      <AirPlayPresentDialog
        open={airplayOpen}
        targetType="group"
        targetId={groupData.id}
        destinationName={groupData.name}
        displayCount={groupData.membershipCount}
        csrfToken={csrf}
        capabilities={capabilities}
        capabilityLoading={groupAirplayQueries.some((query) => query.isPending)}
        capabilityError={airplayError}
        audioDisplayName={
          groupData.presentationGatewayScreenId
            ? groupData.screens.find(
                (screen) => screen.id === groupData.presentationGatewayScreenId,
              )?.name
            : t("groups.detail.audioAutomatic")
        }
        onClose={() => setAirplayOpen(false)}
      />
      <QuickPresentDialog
        open={quickPresentOpen}
        targetType="group"
        targetId={groupData.id}
        destinationName={groupData.name}
        csrfToken={csrf}
        onClose={() => setQuickPresentOpen(false)}
      />
      {editOpen && (
        <DisplayGroupDialog open group={groupData} onOpenChange={setEditOpen} />
      )}
      {manageable && (
        <AddScreensPicker
          group={groupData}
          open={addOpen}
          onOpenChange={setAddOpen}
        />
      )}
      {deletion.dialog}

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
            {policyDirty && (
              <Badge variant="secondary">
                {t("groups.detail.unsavedBadge")}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {tab === "overview" && (
          <TabsContent value="overview" className="min-w-0 outline-none">
            <DisplayGroupOverview
              group={groupData}
              health={health}
              manageable={manageable}
              onNavigate={selectTab}
              onAddScreens={() => {
                selectTab("members");
                setAddOpen(true);
              }}
            />
          </TabsContent>
        )}
        {tab === "members" && (
          <TabsContent value="members" className="min-w-0 outline-none">
            <DisplayGroupScreens
              group={groupData}
              inventory={inventory}
              manageable={manageable}
              onAddScreens={() => setAddOpen(true)}
            />
          </TabsContent>
        )}
        {tab === "content" && (
          <TabsContent value="content" className="min-w-0 outline-none">
            <DisplayGroupPlayback group={groupData} manageable={manageable} />
          </TabsContent>
        )}
        {tab === "display" && (
          <TabsContent value="display" className="min-w-0 outline-none">
            <DisplayGroupDisplay
              group={groupData}
              manageable={manageable}
              csrfToken={csrf}
            />
          </TabsContent>
        )}
        {tab === "policy" && (
          <TabsContent value="policy" className="min-w-0 outline-none">
            <PlayerPolicyEditor
              target="group"
              id={id}
              onDirtyChange={setPolicyDirty}
            />
          </TabsContent>
        )}
      </Tabs>

      <Dialog
        open={pendingDestination !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDestination(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("groups.detail.discardTitle")}</DialogTitle>
            <DialogDescription>
              {t("groups.detail.discardBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDestination(null)}
            >
              {t("groups.detail.keepEditing")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDestination) commitDestination(pendingDestination);
              }}
            >
              {t("groups.detail.discardAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
