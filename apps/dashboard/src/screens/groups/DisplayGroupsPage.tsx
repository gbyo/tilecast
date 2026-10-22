import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { ScreenGroup } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import type { StudioActionGroup } from "../../components/studio/ActionMenu";
import { DisplayGroupDialog } from "./DisplayGroupDialog";
import { DisplayGroupsResults } from "./DisplayGroupsResults";
import { DisplayGroupsToolbar } from "./DisplayGroupsToolbar";
import { canManageGroups, groupPath } from "./displayGroupModel";
import { useDeleteDisplayGroup } from "./useDeleteDisplayGroup";
import { useDisplayGroupsList } from "./useDisplayGroupsList";
import {
  CollectionPage,
  CollectionSurface,
} from "../../components/collection/CollectionPage";

/** The Display Groups index: search, compare, and open groups. */
export function DisplayGroupsPage() {
  const { t } = useTranslation("screens");
  const navigate = useNavigate();
  const manageable = canManageGroups(useAuth().status);
  const list = useDisplayGroupsList();
  const { groups } = list;
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ScreenGroup | null>(null);
  const deletion = useDeleteDisplayGroup();

  const summary = !groups.isSuccess
    ? " "
    : list.search.trim() !== ""
      ? t("groups.summary.matching", { count: list.total })
      : list.groupedScreens === undefined
        ? t("groups.summary.groups", { count: list.total })
        : t("groups.summary.withScreens", {
            groups: t("groups.summary.groups", { count: list.total }),
            screens: t("groups.summary.screensGrouped", {
              count: list.groupedScreens,
            }),
          });

  const actionsFor = (group: ScreenGroup): StudioActionGroup[] => [
    {
      actions: [
        {
          id: "open",
          label: t("groups.actions.open"),
          onSelect: () => void navigate(groupPath(group.id)),
        },
      ],
    },
    ...(manageable
      ? [
          {
            actions: [
              {
                id: "edit",
                label: t("groups.actions.edit"),
                onSelect: () => setEditing(group),
              },
            ],
          },
          {
            actions: [
              {
                id: "delete",
                label: t("groups.actions.delete"),
                role: "destructive" as const,
                onSelect: () => void deletion.requestDelete(group),
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <CollectionPage
      title={t("groups.title")}
      description={t("groups.description")}
      className="space-y-4"
    >
      <DisplayGroupsToolbar
        summary={summary}
        search={list.typedSearch.value}
        onSearchChange={list.typedSearch.onChange}
        onSearchBlur={list.typedSearch.onBlur}
        onCreate={manageable ? () => setCreateOpen(true) : undefined}
      />
      <CollectionSurface>
        <DisplayGroupsResults
        state={{
          groups: list.rows,
          loading: groups.isLoading,
          error: groups.isError,
          fetching: groups.isFetching,
          hasNextPage: groups.hasNextPage,
          fetchingNextPage: groups.isFetchingNextPage,
        }}
        search={list.search}
        screens={list.screens}
        manageable={manageable}
        actionsFor={actionsFor}
        onRetry={() => void groups.refetch()}
        onLoadMore={() => void groups.fetchNextPage()}
        onClearSearch={() => list.setSearch("")}
          onCreate={() => setCreateOpen(true)}
        />
      </CollectionSurface>

      {createOpen && (
        <DisplayGroupDialog
          open
          onOpenChange={setCreateOpen}
          onSaved={(created) => void navigate(groupPath(created.id, "members"))}
        />
      )}
      {editing && (
        <DisplayGroupDialog
          key={editing.id}
          open
          group={editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      )}
      {deletion.dialog}
    </CollectionPage>
  );
}
