import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { MoreHorizontal } from "lucide-react";
import { useNativeHost } from "../../native-host/NativeHostProvider";
import {
  useNativeActionMenu,
  type NativeMenuAction,
  type NativeMenuGroup,
} from "../../native-host/useNativeActionMenu";
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
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { ActionIcon } from "./actionIcons";

/**
 * One action of a Studio action menu. Define it once: the same list
 * powers the browser dropdown, the browser context menu, and the native
 * iOS menu when the host offers one.
 */
export type StudioAction = NativeMenuAction;
export type StudioActionGroup = NativeMenuGroup;

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
              variant={action.role === "destructive" ? "destructive" : "default"}
              disabled={action.disabled}
              onClick={action.onSelect}
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
 * A three-dot button with a Studio action menu. In an ordinary browser
 * the menu is the normal web dropdown. In a native host that offers
 * action menus the button shows the native menu instead, and falls back
 * to the web menu when the host cannot show it. Renders nothing without
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
  const { present } = useNativeActionMenu();
  const host = useNativeHost();
  const hostAvailable =
    host.status === "ready" && host.capabilities.nativeActionMenus;
  const [webOpen, setWebOpen] = useState(false);
  const presenting = useRef(false);

  const count = actions.reduce((sum, group) => sum + group.actions.length, 0);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setWebOpen(false);
        return;
      }
      // Without a host that offers menus the web menu opens at once,
      // exactly as before native menus existed.
      if (!hostAvailable) {
        setWebOpen(true);
        return;
      }
      if (presenting.current) return;
      presenting.current = true;
      void present(label, actions)
        .then((result) => {
          if (result.outcome === "unavailable") setWebOpen(true);
        })
        .finally(() => {
          presenting.current = false;
        });
    },
    [actions, hostAvailable, label, present],
  );

  if (count === 0) return null;
  return (
    <DropdownMenu open={webOpen} onOpenChange={handleOpenChange}>
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
 * A right-click and long-press menu for a whole row or card. The browser
 * path is the normal web context menu. In a native host that offers
 * action menus, pressing the target also arms the native context menu
 * for a long press; releasing, cancelling, or scrolling disarms it. The
 * armed entry is inert until the host shows it, so the web menu keeps
 * working wherever the host does not take over.
 */
export function ActionContextMenu({
  label,
  actions,
  children,
  className,
  render,
}: {
  /** Accessibility label, for example "Actions for Lobby Screen". */
  label: string;
  actions: StudioActionGroup[];
  children: ReactNode;
  className?: string;
  /** Replaces the trigger element, as the underlying primitive allows. */
  render?: ReactElement;
}) {
  const { arm } = useNativeActionMenu();
  const disarm = useRef<(() => void) | null>(null);

  const disarmCurrent = useCallback(() => {
    disarm.current?.();
    disarm.current = null;
  }, []);

  useEffect(() => () => disarmCurrent(), [disarmCurrent]);

  const handlePointerDown = useCallback(() => {
    disarmCurrent();
    const stop = arm(label, actions);
    if (!stop) return;
    const onScroll = () => disarmCurrent();
    window.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    disarm.current = () => {
      disarm.current = null;
      window.removeEventListener("scroll", onScroll, { capture: true });
      stop();
    };
  }, [actions, arm, disarmCurrent, label]);

  const count = actions.reduce((sum, group) => sum + group.actions.length, 0);
  if (count === 0) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        onPointerDown={handlePointerDown}
        onPointerUp={disarmCurrent}
        onPointerCancel={disarmCurrent}
        className={className}
        render={render}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={label}>
        <ActionGroups
          groups={actions}
          Item={ContextMenuItem}
          Separator={ContextMenuSeparator}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
