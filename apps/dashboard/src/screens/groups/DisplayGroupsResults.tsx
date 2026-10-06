import { SearchX, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Screen, ScreenGroup } from "../../api/types";
import { useCompactLayout } from "../../hooks/use-compact-layout";
import type { StudioActionGroup } from "../../components/studio/ActionMenu";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { Skeleton } from "../../components/ui/skeleton";
import { GroupItems, GroupTable } from "./DisplayGroupsLists";

export type DisplayGroupsResultsState = {
  groups: ScreenGroup[];
  loading: boolean;
  error: boolean;
  fetching: boolean;
  hasNextPage: boolean;
  fetchingNextPage: boolean;
};

/** Everything under the search field: states, the list, and Load more. */
export function DisplayGroupsResults({
  state,
  search,
  screens,
  manageable,
  actionsFor,
  onRetry,
  onLoadMore,
  onClearSearch,
  onCreate,
}: {
  state: DisplayGroupsResultsState;
  search: string;
  screens: Map<string, Screen> | undefined;
  manageable: boolean;
  actionsFor: (group: ScreenGroup) => StudioActionGroup[];
  onRetry: () => void;
  onLoadMore: () => void;
  onClearSearch: () => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const compact = useCompactLayout();
  const errorAlert = state.error ? (
    <GroupsLoadError fetching={state.fetching} onRetry={onRetry} />
  ) : null;

  if (state.loading)
    return (
      <div className="grid gap-2" aria-label={t("groups.loading")}>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );

  if (state.groups.length === 0)
    return (
      errorAlert ?? (
        <GroupsEmpty
          search={search}
          manageable={manageable}
          onClearSearch={onClearSearch}
          onCreate={onCreate}
        />
      )
    );

  const List = compact ? GroupItems : GroupTable;
  return (
    <>
      {errorAlert}
      <List groups={state.groups} screens={screens} actionsFor={actionsFor} />
      {state.hasNextPage && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={state.fetchingNextPage}
            onClick={onLoadMore}
          >
            {state.fetchingNextPage
              ? t("groups.loading")
              : t("groups.loadMore")}
          </Button>
        </div>
      )}
    </>
  );
}

function GroupsLoadError({
  fetching,
  onRetry,
}: {
  fetching: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>{t("groups.loadError")}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={fetching}
          onClick={onRetry}
        >
          {t("common:actions.retry")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** Two distinct empties: no groups yet, or no group matches the search. */
function GroupsEmpty({
  search,
  manageable,
  onClearSearch,
  onCreate,
}: {
  search: string;
  manageable: boolean;
  onClearSearch: () => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation("screens");
  const searching = search.trim() !== "";
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {searching ? (
            <SearchX aria-hidden="true" />
          ) : (
            <Users aria-hidden="true" />
          )}
        </EmptyMedia>
        <EmptyTitle>
          {searching
            ? t("groups.empty.noMatchTitle", { query: search })
            : t("groups.emptyTitle")}
        </EmptyTitle>
        <EmptyDescription>
          {searching
            ? t("groups.empty.noMatchDescription")
            : t("groups.emptyDescription")}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {searching ? (
          <Button type="button" variant="outline" onClick={onClearSearch}>
            {t("groups.search.clear")}
          </Button>
        ) : (
          manageable && (
            <Button type="button" onClick={onCreate}>
              {t("groups.create")}
            </Button>
          )
        )}
      </EmptyContent>
    </Empty>
  );
}
