import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { SCREEN_STATUS_REFRESH_MS, screenQueries } from "../../data/screens";
import { AddScreensPicker } from "./AddScreensPicker";
import { DisplayGroupHeader } from "./DisplayGroupHeader";
import {
  DisplayGroupDetailLoading,
  DisplayGroupLoadError,
} from "./DisplayGroupDetailStates";
import { DisplayGroupTabs } from "./DisplayGroupTabs";
import {
  canManageGroups,
  groupHealth,
  isGroupNotFound,
  screenInventory,
} from "./displayGroupModel";

/** One Display Group: it loads the group and composes the header and tabs. */
export function DisplayGroupDetailPage() {
  const { id = "" } = useParams();
  const auth = useAuth();
  const manageable = canManageGroups(auth.status?.user?.role);
  const [addOpen, setAddOpen] = useState(false);

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

  if (group.isPending) return <DisplayGroupDetailLoading />;
  if (!group.data)
    return (
      <DisplayGroupLoadError
        notFound={isGroupNotFound(group.error)}
        onRetry={() => void group.refetch()}
      />
    );

  const health = groupHealth(group.data, inventory);
  return (
    <section className="grid gap-4">
      <DisplayGroupHeader
        group={group.data}
        health={health}
        manageable={manageable}
      />
      {manageable && (
        <AddScreensPicker
          group={group.data}
          open={addOpen}
          onOpenChange={setAddOpen}
        />
      )}
      <DisplayGroupTabs
        group={group.data}
        health={health}
        inventory={inventory}
        manageable={manageable}
        csrfToken={auth.status?.csrfToken ?? ""}
        onAddScreens={() => setAddOpen(true)}
      />
    </section>
  );
}
