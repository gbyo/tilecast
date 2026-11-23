import { Fragment, useState, type ReactElement, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "../ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "../ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  useAnyCoarsePointer,
  useFineHoverPointer,
} from "../../hooks/use-media-query";
import { ActionIcon } from "./actionIcons";

/**
 * Define semantic commands once; each surface presents the applicable set.
 */
export type StudioAction = {
  /** Stable within one menu. Never derived from the label. */
  id: string;
  /** Already localized. */
  label: string;
  /** Semantic icon token. Unknown tokens show no icon. */
  icon?: string;
  disabled?: boolean;
  /** Omit a redundant command from one surface. Permissions belong upstream. */
  surface?: "dropdown" | "context";
  /** Hint for an existing keyboard binding; shown only in the dropdown. */
  shortcut?: string;
  role?: "default" | "destructive";
  onSelect: () => void;
};

/** Children are commands, so the type permits exactly one submenu level. */
export type StudioSubmenu = Pick<
  StudioAction,
  "id" | "label" | "icon" | "disabled" | "surface"
> & {
  items: StudioAction[];
};

export type StudioMenuEntry = StudioAction | StudioSubmenu;
export type StudioActionGroup = { actions: StudioMenuEntry[] };
type MenuSurface = "dropdown" | "context";

/** Filter before rendering separators or deciding whether a trigger is active. */
export function actionsForSurface(
  groups: StudioActionGroup[],
  surface: MenuSurface,
): StudioActionGroup[] {
  const applies = (entry: StudioMenuEntry): boolean =>
    (!entry.surface || entry.surface === surface) &&
    (surface !== "context" || !entry.disabled);
  return groups
    .map(({ actions }) => {
      const visible: StudioMenuEntry[] = [];
      for (const entry of actions) {
        if (!applies(entry)) continue;
        if ("items" in entry) {
          const items = entry.items.filter(applies);
          if (items.length > 0) visible.push({ ...entry, items });
        } else {
          visible.push(entry);
        }
      }
      return { actions: visible };
    })
    .filter(({ actions }) => actions.length > 0);
}

/** Base UI owns activation, submenu navigation, dismissal and focus return. */
function ActionGroups({
  groups,
  surface,
}: {
  groups: StudioActionGroup[];
  surface: MenuSurface;
}) {
  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  const Separator =
    surface === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  const Sub = surface === "context" ? ContextMenuSub : DropdownMenuSub;
  const SubTrigger =
    surface === "context" ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const SubContent =
    surface === "context" ? ContextMenuSubContent : DropdownMenuSubContent;
  const label = (entry: StudioMenuEntry) => (
    <>
      {entry.icon && <ActionIcon token={entry.icon} />}
      {entry.label}
    </>
  );
  const command = (action: StudioAction) => (
    <Item
      key={action.id}
      variant={action.role === "destructive" ? "destructive" : "default"}
      disabled={action.disabled}
      onClick={() => action.onSelect()}
    >
      {label(action)}
      {surface === "dropdown" && action.shortcut && (
        <DropdownMenuShortcut>{action.shortcut}</DropdownMenuShortcut>
      )}
    </Item>
  );
  return (
    <>
      {groups.map((group, index) => (
        <Fragment key={group.actions.map((entry) => entry.id).join(":")}>
          {index > 0 && <Separator />}
          {group.actions.map((entry) =>
            "items" in entry ? (
              <Sub key={entry.id}>
                <SubTrigger disabled={entry.disabled}>
                  {label(entry)}
                </SubTrigger>
                <SubContent aria-label={entry.label}>
                  {entry.items.map(command)}
                </SubContent>
              </Sub>
            ) : (
              command(entry)
            ),
          )}
        </Fragment>
      ))}
    </>
  );
}

function TouchActionGroups({ groups }: { groups: StudioActionGroup[] }) {
  const label = (entry: StudioMenuEntry) => (
    <>
      {entry.icon && <ActionIcon token={entry.icon} />}
      {entry.label}
    </>
  );
  const actionButton = (
    action: StudioAction,
    disabled = action.disabled ?? false,
  ) => (
    <DrawerClose
      key={action.id}
      render={
        <Button
          type="button"
          variant={action.role === "destructive" ? "destructive" : "ghost"}
          className="w-full justify-start"
          disabled={disabled}
        />
      }
      onClick={() => action.onSelect()}
    >
      {label(action)}
    </DrawerClose>
  );

  return (
    <div className="grid min-h-0 gap-2 overflow-y-auto px-4 pb-4">
      {groups.map((group, index) => (
        <section
          key={group.actions.map((entry) => entry.id).join(":")}
          className={index === 0 ? "grid gap-1" : "grid gap-1 border-t pt-2"}
        >
          {group.actions.map((entry) =>
            "items" in entry ? (
              <div key={entry.id} className="grid gap-1">
                <p className="flex min-h-8 items-center gap-2 px-2.5 text-xs font-medium text-muted-foreground">
                  {label(entry)}
                </p>
                {entry.items.map((action) =>
                  actionButton(
                    action,
                    Boolean(entry.disabled || action.disabled),
                  ),
                )}
              </div>
            ) : (
              actionButton(entry)
            ),
          )}
        </section>
      ))}
    </div>
  );
}

/**
 * A three-dot button with a Studio action menu. Renders nothing without
 * actions.
 */
export function ActionMenuButton({
  label,
  actions,
  align = "end",
  variant = "outline",
  size = "icon",
  triggerClassName,
  triggerIcon,
}: {
  /** Accessibility label, for example "Actions for Lobby Screen". */
  label: string;
  actions: StudioActionGroup[];
  align?: "start" | "center" | "end";
  variant?: "outline" | "ghost";
  size?: "icon" | "icon-sm";
  /** Extra classes for the trigger button, for example positioning. */
  triggerClassName?: string;
  /** The trigger glyph. A horizontal ellipsis by default. */
  triggerIcon?: ReactNode;
}) {
  const visible = actionsForSurface(actions, "dropdown");
  const touch = useAnyCoarsePointer();
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (visible.length === 0) return null;

  const trigger = (
    <Button variant={variant} size={size} className={triggerClassName} />
  );

  if (touch) {
    return (
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} showSwipeHandle>
        <DrawerTrigger render={trigger} aria-label={label}>
          {triggerIcon ?? <MoreHorizontal aria-hidden="true" />}
        </DrawerTrigger>
        <DrawerContent aria-label={label}>
          <DrawerHeader>
            <DrawerTitle>{label}</DrawerTitle>
          </DrawerHeader>
          <TouchActionGroups groups={visible} />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} aria-label={label}>
        {triggerIcon ?? <MoreHorizontal aria-hidden="true" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} aria-label={label}>
        <ActionGroups groups={visible} surface="dropdown" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A pointer context menu for a whole row or card. It is enabled when any
 * precise hovering input is available, including Apple Pencil or an attached
 * trackpad, while the visible action button remains the touch path. Keep the trigger
 * mounted so entering batch selection does not discard focus or observers.
 */
export function ActionContextMenu({
  label,
  title,
  actions,
  children,
  className,
  render,
}: {
  /** Accessibility label, for example "Actions for Lobby Screen". */
  label: string;
  /** Visible resource name shown at the top of the context menu. */
  title?: string;
  actions: StudioActionGroup[];
  children: ReactNode;
  className?: string;
  /** Replaces the trigger element, as the underlying primitive allows. */
  render?: ReactElement;
}) {
  const visible = actionsForSurface(actions, "context");
  const count = visible.length;
  const canHover = useFineHoverPointer();
  return (
    <ContextMenu disabled={count === 0 || !canHover}>
      <ContextMenuTrigger
        suppressModifiedClick={count > 0 && canHover}
        className={
          className ?? (count === 0 && !render ? "contents" : undefined)
        }
        render={render}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56" aria-label={label}>
        <ContextMenuGroup>
          {title ? (
            <>
              <ContextMenuLabel className="max-w-52 truncate">
                {title}
              </ContextMenuLabel>
              <ContextMenuSeparator />
            </>
          ) : null}
          <ActionGroups groups={visible} surface="context" />
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
