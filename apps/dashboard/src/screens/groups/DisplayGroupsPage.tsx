import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { Plus, SearchX, Users } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../../api/client";
import { hasNextPage } from "../../api/pagination";
import type { Screen, ScreenGroup } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { DashboardSearch } from "../../components/DashboardListToolbar";
import { useTypedFilter } from "../../components/FilterBar";
import { ActionMenuButton } from "../../components/studio/ActionMenu";
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "../../components/ui/item";
import { Skeleton } from "../../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { useCompactLayout } from "../../hooks/use-compact-layout";
import { screenQueries, SCREEN_STATUS_REFRESH_MS } from "../../data/screens";
import { GroupHealthText, healthSentence } from "./DisplayGroupHealth";
import { DisplayGroupDialog } from "./DisplayGroupDialog";
import {
  canManageGroups,
  groupedScreenCount,
  groupFallback,
  groupHealth,
  groupPath,
  screenInventory,
} from "./displayGroupModel";
import type { GroupHealth } from "./displayGroupModel";
import { useDeleteDisplayGroup } from "./useDeleteDisplayGroup";

export function DisplayGroupsPage() {
  const { t } = useTranslation(["screens", "common"]);
  const navigate = useNavigate();
  const manageable = canManageGroups(useAuth().status?.user?.role);
  const compact = useCompactLayout();
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get("q") ?? "";
  const setSearch = useCallback(
    (value: string) =>
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value) next.set("q", value);
          else next.delete("q");
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );
  const typedSearch = useTypedFilter(search, setSearch);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ScreenGroup | null>(null);
  const deletion = useDeleteDisplayGroup();

  const groups = useInfiniteQuery({
    queryKey: ["screen-groups", "page", { search }],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api.screenGroupPage(search, pageParam),
    getNextPageParam: (page) => (hasNextPage(page) ? page.page + 1 : undefined),
    placeholderData: keepPreviousData,
  });
  const inventory = useQuery({
    ...screenQueries.list(),
    refetchInterval: SCREEN_STATUS_REFRESH_MS,
  });
  const screens = screenInventory(inventory.data?.items);
  const rows = groups.data?.pages.flatMap((page) => page.items) ?? [];
  const total = groups.data?.pages[0]?.total ?? rows.length;
  const grouped = groupedScreenCount(inventory.data?.items);
  const searching = search.trim() !== "";
  const loading = groups.isLoading;

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
    <section className="w-full min-w-0 space-y-4">
      {/* The Studio top bar names the page. The h1 stays for document
          structure and assistive technology. */}
      <h1 className="sr-only">{t("groups.title")}</h1>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-muted-foreground tabular-nums">
          {groups.isSuccess
            ? searching
              ? t("groups.summary.matching", { count: total })
              : grouped === undefined
                ? t("groups.summary.groups", { count: total })
                : t("groups.summary.withScreens", {
                    groups: t("groups.summary.groups", { count: total }),
                    screens: t("groups.summary.screensGrouped", {
                      count: grouped,
                    }),
                  })
            : " "}
        </p>
        {manageable && (
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden="true" /> {t("groups.createShort")}
          </Button>
        )}
      </div>

      <div onBlur={typedSearch.onBlur}>
        <DashboardSearch
          value={typedSearch.value}
          onValueChange={typedSearch.onChange}
          label={t("groups.search.label")}
          placeholder={t("groups.search.placeholder")}
          clearLabel={t("groups.search.clearInput")}
          className="max-w-none"
        />
      </div>

      {groups.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{t("groups.loadError")}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={groups.isFetching}
              onClick={() => void groups.refetch()}
            >
              {t("common:actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loading && (
        <div className="grid gap-2" aria-label={t("groups.loading")}>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}

      {!loading && !groups.isError && rows.length === 0 && (
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
              <Button
                type="button"
                variant="outline"
                onClick={() => setSearch("")}
              >
                {t("groups.search.clear")}
              </Button>
            ) : (
              manageable && (
                <Button type="button" onClick={() => setCreateOpen(true)}>
                  {t("groups.create")}
                </Button>
              )
            )}
          </EmptyContent>
        </Empty>
      )}

      {rows.length > 0 &&
        (compact ? (
          <GroupItems groups={rows} screens={screens} actionsFor={actionsFor} />
        ) : (
          <GroupTable groups={rows} screens={screens} actionsFor={actionsFor} />
        ))}

      {groups.hasNextPage && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={groups.isFetchingNextPage}
            onClick={() => void groups.fetchNextPage()}
          >
            {groups.isFetchingNextPage
              ? t("groups.loading")
              : t("groups.loadMore")}
          </Button>
        </div>
      )}

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
    </section>
  );
}

type RowProps = {
  groups: ScreenGroup[];
  screens: Map<string, Screen> | undefined;
  actionsFor: (group: ScreenGroup) => StudioActionGroup[];
};

function healthOf(
  group: ScreenGroup,
  screens: Map<string, Screen> | undefined,
): GroupHealth {
  return groupHealth(group, screens);
}

function ModeLabel({ group }: { group: ScreenGroup }) {
  const { t } = useTranslation("screens");
  return (
    <>
      {group.displayMode === "span"
        ? t("groups.detail.modeSpan")
        : t("groups.detail.modeMirror")}
    </>
  );
}

function FallbackCell({ group }: { group: ScreenGroup }) {
  const { t } = useTranslation("screens");
  const fallback = groupFallback(group);
  if (!fallback)
    return (
      <span className="text-muted-foreground">
        {t("groups.fallbackType.none")}
      </span>
    );
  return (
    <span className="grid min-w-0">
      <span className="truncate">{fallback.name}</span>
      <span className="text-xs text-muted-foreground">
        {t(`groups.fallbackType.${fallback.kind}`)}
      </span>
    </span>
  );
}

function GroupTable({ groups, screens, actionsFor }: RowProps) {
  const { t } = useTranslation("screens");
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("groups.columns.group")}</TableHead>
          <TableHead>{t("groups.columns.screens")}</TableHead>
          <TableHead>{t("groups.columns.mode")}</TableHead>
          <TableHead>{t("groups.columns.fallback")}</TableHead>
          <TableHead className="w-12">
            <span className="sr-only">{t("groups.columns.actions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => (
          <TableRow key={group.id}>
            <TableCell className="max-w-80">
              <Link
                to={groupPath(group.id)}
                className="grid min-w-0 gap-0.5 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="truncate font-medium">{group.name}</span>
                {group.description && (
                  <span className="truncate text-xs text-muted-foreground">
                    {group.description}
                  </span>
                )}
              </Link>
            </TableCell>
            <TableCell>
              <GroupHealthText health={healthOf(group, screens)} />
            </TableCell>
            <TableCell>
              <ModeLabel group={group} />
            </TableCell>
            <TableCell className="max-w-56">
              <FallbackCell group={group} />
            </TableCell>
            <TableCell className="text-right">
              <ActionMenuButton
                label={t("groups.actions.label", { name: group.name })}
                actions={actionsFor(group)}
                variant="ghost"
                size="icon-sm"
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function GroupItems({ groups, screens, actionsFor }: RowProps) {
  const { t } = useTranslation("screens");
  return (
    <ItemGroup>
      {groups.map((group, index) => {
        const fallback = groupFallback(group);
        return (
          <div key={group.id} role="listitem">
            {index > 0 && <ItemSeparator className="my-0" />}
            <Item size="sm" className="px-0">
              <ItemContent>
                <ItemTitle>
                  <Link to={groupPath(group.id)} className="truncate">
                    {group.name}
                  </Link>
                </ItemTitle>
                <ItemDescription>
                  {healthSentence(healthOf(group, screens), t)}
                </ItemDescription>
                <ItemDescription>
                  {t("groups.inlineSummary", {
                    mode:
                      group.displayMode === "span"
                        ? t("groups.detail.modeSpan")
                        : t("groups.detail.modeMirror"),
                    fallback: fallback
                      ? t("groups.fallbackInline", {
                          type: t(`groups.fallbackType.${fallback.kind}`),
                          name: fallback.name,
                        })
                      : t("groups.fallbackType.none"),
                  })}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <ActionMenuButton
                  label={t("groups.actions.label", { name: group.name })}
                  actions={actionsFor(group)}
                  variant="ghost"
                  size="icon-sm"
                />
              </ItemActions>
            </Item>
          </div>
        );
      })}
    </ItemGroup>
  );
}
