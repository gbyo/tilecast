import type { TFunction } from "i18next";
import type { NavigateFunction } from "react-router";
import { api } from "../api/client";
import type { Screen } from "../api/types";
import { screenSupportsCommand } from "../screens/commandApplicability";
import type { StudioActionGroup } from "./studio/ActionMenu";

type ScreensT = TFunction<"screens", undefined>;

/**
 * The row actions shared by the screen grid cards and the fleet table:
 * Prioritize presenting content, then maintenance, then consequential archive.
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
  const maintenance: StudioActionGroup["actions"] = [];
  if (canManage) {
    primary.push(
      {
        id: "show-now",
        label: t("grid.showNow"),
        icon: "play",
        onSelect: () => void navigate(`/screens/${screen.id}?present=1`),
      },
      {
        id: "assign-content",
        label: t("grid.assignContent"),
        icon: "playlists",
        onSelect: () => void navigate(`/screens/${screen.id}?focus=content`),
      },
    );
    maintenance.push({
      id: "edit-details",
      label: t("grid.editDetails"),
      icon: "details",
      onSelect: () => void navigate(`/screens/${screen.id}?edit=details`),
    });
  }
  const group: StudioActionGroup["actions"] = canManage
    ? [
        {
          id: "sync-group",
          label: screen.syncGroupId
            ? t("grid.openGroup")
            : t("grid.addToGroup"),
          icon: "group",
          onSelect: () =>
            void navigate(
              screen.syncGroupId ? `/groups/${screen.syncGroupId}` : "/groups",
            ),
        },
      ]
    : [];
  maintenance.push(...group);
  if (canManage && screenSupportsCommand(screen, "restart_player_process"))
    maintenance.push({
      id: "restart",
      label: t("grid.restartPlayer"),
      icon: "restart",
      onSelect: () =>
        void api.createScreenCommand(
          screen.id,
          "restart_player_process",
          {},
          csrfToken,
        ),
    });
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
  return [
    { actions: primary },
    { actions: maintenance },
    { actions: destructive },
  ];
}
