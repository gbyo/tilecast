import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { PlayerRelease, PlayerReleaseList } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { toast } from "../../components/ui/toast";
import {
  PurgeReleaseDialog,
  ReleaseDetailSurface,
  ReleaseGroupList,
  ReleaseLibraryAlerts,
  ReleaseLibraryHeader,
} from "./ReleaseLibraryParts";
import { groupReleases } from "./model";

export function ReleaseLibrary({
  items,
  catalog,
  owner,
  manageable,
  syncError,
  onDeploy,
  onConfigure,
}: {
  items: PlayerRelease[];
  catalog?: PlayerReleaseList;
  owner: boolean;
  manageable: boolean;
  syncError?: unknown;
  onDeploy: (id: string) => void;
  onConfigure: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const csrf = useAuth().status?.csrfToken ?? "";
  const client = useQueryClient();
  const [detailIds, setDetailIds] = useState<string[]>();
  const [purging, setPurging] = useState<PlayerRelease>();

  const cache = useMutation({
    mutationFn: (id: string) => api.cachePlayerRelease(id, csrf),
    onSuccess: () => {
      toast.add({
        title: t("updates.console.prepareRequested"),
        type: "success",
      });
      return client.invalidateQueries({ queryKey: ["player-releases"] });
    },
  });
  const purge = useMutation({
    mutationFn: (release: PlayerRelease) =>
      api.deletePlayerRelease(release.id, csrf),
    onSuccess: (result) => {
      setPurging(undefined);
      toast.add({
        title: result.deleted
          ? t("updates.panel.purgeDeleted")
          : t("updates.panel.purgeFreed"),
        type: "success",
      });
      return client.invalidateQueries({ queryKey: ["player-releases"] });
    },
  });

  const grouped = groupReleases(items);
  const detailIdSet = new Set(detailIds ?? []);
  const detailed = items.filter((release) => detailIdSet.has(release.id));

  function deploy(id: string) {
    setDetailIds(undefined);
    onDeploy(id);
  }

  function requestPurge(release: PlayerRelease) {
    purge.reset();
    setPurging(release);
  }

  return (
    <div className="grid gap-5">
      <ReleaseLibraryHeader
        catalog={catalog}
        owner={owner}
        onConfigure={onConfigure}
      />
      <ReleaseLibraryAlerts
        catalog={catalog}
        syncError={syncError}
        cacheError={cache.error}
      />
      <ReleaseGroupList
        groups={grouped}
        owner={owner}
        manageable={manageable}
        cachePending={cache.isPending}
        purgePending={purge.isPending}
        onOpenDetails={setDetailIds}
        onDeploy={deploy}
        onCache={(id) => cache.mutate(id)}
        onRequestPurge={requestPurge}
      />
      <ReleaseDetailSurface
        releases={detailed}
        owner={owner}
        manageable={manageable}
        cachePending={cache.isPending}
        purgePending={purge.isPending}
        onClose={() => setDetailIds(undefined)}
        onDeploy={deploy}
        onCache={(id) => cache.mutate(id)}
        onRequestPurge={requestPurge}
      />
      <PurgeReleaseDialog
        release={purging}
        pending={purge.isPending}
        error={purge.error}
        onClose={() => setPurging(undefined)}
        onConfirm={(release) => purge.mutate(release)}
      />
    </div>
  );
}
