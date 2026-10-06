import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { api } from "../../api/client";
import type { Screen, ScreenGroup } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { DashboardSearch } from "../../components/DashboardListToolbar";
import { ActionMenuButton } from "../../components/studio/ActionMenu";
import type { StudioActionGroup } from "../../components/studio/ActionMenu";
import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { toast } from "../../components/ui/toast";
import { useCompactLayout } from "../../hooks/use-compact-layout";
import { screenStatusText } from "./groupHealthModel";
import { ScreenHealthStatus } from "./DisplayGroupHealth";
import { screenKeys } from "../../data/screens";

type Member = ScreenGroup["screens"][number];

/** The Screens tab: who is in the group, with Fleet's health vocabulary. */
export function DisplayGroupScreens({
  group,
  inventory,
  manageable,
  onAddScreens,
}: {
  group: ScreenGroup;
  inventory: ReadonlyMap<string, Screen> | undefined;
  manageable: boolean;
  onAddScreens: () => void;
}) {
  const { t } = useTranslation("screens");
  const compact = useCompactLayout();
  const navigate = useNavigate();
  const csrf = useAuth().status?.csrfToken ?? "";
  const client = useQueryClient();
  const [search, setSearch] = useState("");

  const remove = useMutation({
    mutationFn: (screenId: string) =>
      api.removeScreenFromGroup(group.id, screenId, csrf),
    onSuccess: async () => {
      toast.add({ title: t("groups.detail.removed"), type: "success" });
      await client.invalidateQueries({ queryKey: ["screen-groups"] });
      await client.invalidateQueries({ queryKey: screenKeys.all });
    },
    onError: () =>
      toast.add({ title: t("groups.errors.removeScreen"), type: "error" }),
  });

  const members = useMemo(() => {
    const query = search.trim().toLowerCase();
    return group.screens.filter((member) =>
      query
        ? `${member.name} ${member.location}`.toLowerCase().includes(query)
        : true,
    );
  }, [group.screens, search]);

  const actionsFor = (member: Member): StudioActionGroup[] => [
    {
      actions: [
        {
          id: "open",
          label: t("groups.detail.openScreen"),
          onSelect: () => void navigate(`/screens/${member.id}`),
        },
      ],
    },
    ...(manageable
      ? [
          {
            actions: [
              {
                id: "remove",
                label: t("groups.detail.removeFromGroup"),
                disabled: remove.isPending,
                role: "destructive" as const,
                onSelect: () => remove.mutate(member.id),
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <h2 className="text-base font-semibold">
            {t("groups.detail.screensLabel")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("groups.detail.membersSummary", {
              count: group.membershipCount,
            })}
          </p>
        </div>
        {manageable && (
          <Button type="button" size="sm" onClick={onAddScreens}>
            <Plus aria-hidden="true" /> {t("groups.detail.addScreens")}
          </Button>
        )}
      </div>

      {group.screens.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>{t("groups.detail.emptyTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("groups.detail.emptyDescription")}
            </EmptyDescription>
          </EmptyHeader>
          {manageable && (
            <EmptyContent>
              <Button type="button" onClick={onAddScreens}>
                {t("groups.detail.addScreens")}
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <>
          <DashboardSearch
            value={search}
            onValueChange={setSearch}
            label={t("groups.detail.searchLabel")}
            placeholder={t("groups.detail.searchPlaceholder")}
            clearLabel={t("groups.search.clearInput")}
            className="max-w-none"
          />
          {members.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("groups.detail.noMemberMatch")}
            </p>
          ) : compact ? (
            <ItemGroup render={<ul />}>
              {members.map((member, index) => (
                <li key={member.id}>
                  {index > 0 && <ItemSeparator className="my-0" />}
                  <Item size="sm" className="px-0">
                    <ItemContent>
                      <ItemTitle>
                        <Link to={`/screens/${member.id}`}>{member.name}</Link>
                      </ItemTitle>
                      <ItemDescription>
                        {member.location || t("groups.detail.noLocation")} ·{" "}
                        {screenStatusText(inventory?.get(member.id), t)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <ActionMenuButton
                        label={t("groups.detail.memberActions", {
                          name: member.name,
                        })}
                        actions={actionsFor(member)}
                        variant="ghost"
                        size="icon-sm"
                      />
                    </ItemActions>
                  </Item>
                </li>
              ))}
            </ItemGroup>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("groups.detail.colScreen")}</TableHead>
                  <TableHead>{t("groups.detail.colLocation")}</TableHead>
                  <TableHead>{t("groups.detail.colStatus")}</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">
                      {t("groups.columns.actions")}
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell className="font-medium">
                      <Link
                        to={`/screens/${member.id}`}
                        className="rounded-sm outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {member.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {member.location || t("groups.detail.noLocation")}
                    </TableCell>
                    <TableCell>
                      <ScreenHealthStatus screen={inventory?.get(member.id)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <ActionMenuButton
                        label={t("groups.detail.memberActions", {
                          name: member.name,
                        })}
                        actions={actionsFor(member)}
                        variant="ghost"
                        size="icon-sm"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </div>
  );
}
