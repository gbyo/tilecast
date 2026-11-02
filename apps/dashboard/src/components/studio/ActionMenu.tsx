import {
  Fragment,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { ActionIcon } from "./actionIcons";

/**
 * One action of a Studio action menu. Define it once: the same list
 * powers the dropdown and the context menu.
 */
export type StudioAction = {
  /** Stable within one menu. Never derived from the label. */
  id: string;
  /** Already localized. */
  label: string;
  /** Semantic icon token. Unknown tokens show no icon. */
  icon?: string;
  disabled?: boolean;
  role?: "default" | "destructive";
  onSelect: () => void;
};

export type StudioActionGroup = {
  actions: StudioAction[];
};

type ItemProps = {
  variant: "default" | "destructive";
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
};

/** The shared web renderer. Empty groups disappear. */
function ActionGroups({
  groups,
  Item,
  Separator,
}: {
  groups: StudioActionGroup[];
  Item: ComponentType<ItemProps>;
  Separator: ComponentType;
}) {
  const visible = groups.filter((group) => group.actions.length > 0);
  return (
    <>
      {visible.map((group, index) => (
        <Fragment key={index}>
          {index > 0 && <Separator />}
          {group.actions.map((action) => (
            <Item
              key={action.id}
              variant={
                action.role === "destructive" ? "destructive" : "default"
              }
              disabled={action.disabled}
              onClick={() => action.onSelect()}
            >
              {action.icon === undefined ? null : (
                <ActionIcon token={action.icon} />
              )}
              {action.label}
            </Item>
          ))}
        </Fragment>
      ))}
    </>
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
  const count = actions.reduce((sum, group) => sum + group.actions.length, 0);

  if (count === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant={variant} size={size} className={triggerClassName} />
        }
        aria-label={label}
      >
        {triggerIcon ?? <MoreHorizontal aria-hidden="true" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} aria-label={label}>
        <ActionGroups
          groups={actions}
          Item={DropdownMenuItem}
          Separator={DropdownMenuSeparator}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A right-click and long-press menu for a whole row or card. Renders its
 * trigger disabled without actions. Keep the element mounted so entering
 * batch selection does not discard checkbox focus or preview observers.
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
  const count = actions.reduce((sum, group) => sum + group.actions.length, 0);
  return (
    <ContextMenu disabled={count === 0}>
      <ContextMenuTrigger
        suppressModifiedClick={count > 0}
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
          <ActionGroups
            groups={actions}
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
          />
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
