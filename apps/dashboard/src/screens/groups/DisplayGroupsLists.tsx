import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { Screen, ScreenGroup } from "../../api/types";
import { ActionMenuButton } from "../../components/studio/ActionMenu";
import type { StudioActionGroup } from "../../components/studio/ActionMenu";
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
import { GroupHealthText } from "./DisplayGroupHealth";
import { groupFallback, groupHealth, groupPath } from "./displayGroupModel";
import type { GroupHealth } from "./displayGroupModel";
import { healthSentence } from "./groupHealthModel";

export type RowProps = {
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

export function GroupTable({ groups, screens, actionsFor }: RowProps) {
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

export function GroupItems({ groups, screens, actionsFor }: RowProps) {
  const { t } = useTranslation("screens");
  return (
    <ItemGroup render={<ul />}>
      {groups.map((group, index) => {
        const fallback = groupFallback(group);
        return (
          <li key={group.id}>
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
          </li>
        );
      })}
    </ItemGroup>
  );
}
