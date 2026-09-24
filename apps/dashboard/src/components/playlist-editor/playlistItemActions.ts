import type { PlaylistsT } from "./playlistEditorModel";

export type PlaylistItemActionId =
  "inspect" | "move-up" | "move-down" | "move-top" | "move-bottom" | "remove";

export type PlaylistItemAction = {
  id: PlaylistItemActionId;
  label: string;
  shortcut?: string;
  disabled: boolean;
  destructive?: boolean;
  /** Actions in different groups are divided by a menu separator. */
  group: "inspect" | "order" | "remove";
};

// playlistItemActions is the single command model for a timeline row. The
// visible overflow DropdownMenu and the supplemental ContextMenu both render
// this list, so the two surfaces cannot offer different commands.
export function playlistItemActions({
  index,
  itemCount,
  canManage,
  t,
}: {
  index: number;
  itemCount: number;
  canManage: boolean;
  t: PlaylistsT;
}): PlaylistItemAction[] {
  const actions: PlaylistItemAction[] = [
    {
      id: "inspect",
      label: t("timeline.actions.inspect"),
      disabled: false,
      group: "inspect",
    },
  ];
  if (!canManage) return actions;
  const first = index === 0;
  const last = index === itemCount - 1;
  actions.push(
    {
      id: "move-up",
      label: t("timeline.moveUp"),
      shortcut: "Alt+↑",
      disabled: first,
      group: "order",
    },
    {
      id: "move-down",
      label: t("timeline.moveDown"),
      shortcut: "Alt+↓",
      disabled: last,
      group: "order",
    },
    {
      id: "move-top",
      label: t("timeline.moveTop"),
      shortcut: "Alt+Home",
      disabled: first,
      group: "order",
    },
    {
      id: "move-bottom",
      label: t("timeline.moveBottom"),
      shortcut: "Alt+End",
      disabled: last,
      group: "order",
    },
    {
      id: "remove",
      label: t("timeline.actions.remove"),
      disabled: false,
      destructive: true,
      group: "remove",
    },
  );
  return actions;
}
