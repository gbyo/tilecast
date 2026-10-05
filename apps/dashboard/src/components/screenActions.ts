import type { TFunction } from "i18next";
import type { NavigateFunction } from "react-router";
import { api } from "../api/client";
import type { Screen } from "../api/types";
import type { StudioActionGroup } from "./studio/ActionMenu";

type ScreensT = TFunction<"screens", undefined>;

/**
 * The row actions shared by the screen grid cards and the fleet table:
 * open, restart, edit details, assign content, show now, sync group, and
 * archive. Both surfaces render the same list through ActionMenu so
 * the browser dropdown and the native menu stay identical; the grid
 * keeps its own trigger label and hides management actions from viewers.
 */
export function screenRowActionGroups({
  screen,
  t,
  navigate,
  csrfToken,
  canManage,
  onArchive,
}: {
  screen: Screen;
  t: ScreensT;
  navigate: NavigateFunction;
  csrfToken: string;
  canManage: boolean;
  onArchive?: () => void;
}): StudioActionGroup[] {
  const primary: StudioActionGroup["actions"] = [
    {
      id: "open",
      label: t("grid.openItem"),
      icon: "screens",
      onSelect: () => void navigate(`/screens/${screen.id}`),
    },
  ];
  if (canManage)
    primary.push(
      {
        id: "restart",
        label: t("grid.restartPlayer"),
        icon: "refresh",
        onSelect: () =>
          void api.createScreenCommand(
            screen.id,
            "restart_player_process",
            {},
            csrfToken,
          ),
      },
      {
        id: "edit-details",
        label: t("grid.editDetails"),
        icon: "details",
        onSelect: () => void navigate(`/screens/${screen.id}?edit=details`),
      },
      {
        id: "assign-content",
        label: t("grid.assignContent"),
        onSelect: () => void navigate(`/screens/${screen.id}?focus=content`),
      },
      {
        id: "show-now",
        label: t("grid.showNow"),
        icon: "play",
        onSelect: () => void navigate(`/screens/${screen.id}?present=1`),
      },
    );
  const group: StudioActionGroup["actions"] = canManage
    ? [
        {
          id: "sync-group",
          label: screen.syncGroupId
            ? t("grid.openGroup")
            : t("grid.addToGroup"),
          onSelect: () =>
            void navigate(
              screen.syncGroupId ? `/groups/${screen.syncGroupId}` : "/groups",
            ),
        },
      ]
    : [];
  const destructive: StudioActionGroup["actions"] =
    canManage && onArchive
      ? [
          {
            id: "archive",
            label: t("detail.archiveMenuAction"),
            icon: "archive",
            role: "destructive",
            onSelect: onArchive,
          },
        ]
      : [];
  return [{ actions: primary }, { actions: group }, { actions: destructive }];
}
