import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { fixedPositionOffset, overlayPortalTarget } from "./overlayPortal";

export type ContextMenuItem = {
  label: string;
  /** Omitted for rows that only open a submenu. */
  onSelect?: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Draws a separator above this item. */
  separated?: boolean;
  /** Related commands folded into a flyout so long menus stay scannable. */
  submenu?: ContextMenuItem[];
};

export type ContextMenuAnchor<Target> = {
  target: Target;
  x: number;
  y: number;
};

/**
 * Tracks which row was right-clicked and where its menu belongs. Right-click and the visible
 * trigger share one opener so both routes produce the same menu at a sensible position.
 */
export function useContextMenu<Target>() {
  const [anchor, setAnchor] = useState<ContextMenuAnchor<Target>>();
  const close = useCallback(() => setAnchor(undefined), []);
  const open = useCallback(
    (event: ReactMouseEvent<HTMLElement>, target: Target) => {
      event.preventDefault();
      event.stopPropagation();
      // Keyboard activation of a trigger button reports no pointer position, so the menu
      // anchors under the control instead of the top-left corner of the viewport.
      const keyboard = event.type === "click" && event.detail === 0;
      const rect = event.currentTarget.getBoundingClientRect();
      setAnchor({
        target,
        x: keyboard ? rect.left : event.clientX,
        y: keyboard ? rect.bottom : event.clientY,
      });
    },
    [],
  );
  return { anchor, open, close };
}

/** Which submenu of a single list is showing, and whether it was opened from the keyboard. */
type OpenSubmenu = { label: string; focus: boolean };

function MenuRow({
  item,
  expanded,
  onOpenSubmenu,
  onCloseSubmenu,
  onClose,
  autoFocusSubmenu,
}: {
  item: ContextMenuItem;
  expanded: boolean;
  onOpenSubmenu: (focus: boolean) => void;
  onCloseSubmenu: () => void;
  onClose: () => void;
  autoFocusSubmenu: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const submenu = item.submenu?.length ? item.submenu : undefined;
  const dismissSubmenu = () => {
    onCloseSubmenu();
    buttonRef.current?.focus();
  };

  const button = (
    <button
      ref={buttonRef}
      type="button"
      role="menuitem"
      aria-haspopup={submenu ? "menu" : undefined}
      aria-expanded={submenu ? expanded : undefined}
      className={`context-menu__item${item.danger ? " context-menu__item--danger" : ""}`}
      disabled={item.disabled}
      onMouseEnter={() => (submenu ? onOpenSubmenu(false) : onCloseSubmenu())}
      onClick={(event) => {
        if (submenu) {
          // Enter/Space on the row reports no pointer position, so only that route
          // pulls focus into the flyout; hovering leaves focus where it was.
          onOpenSubmenu(event.detail === 0);
          return;
        }
        onClose();
        item.onSelect?.();
      }}
      onKeyDown={(event) => {
        if (!submenu || event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        onOpenSubmenu(true);
      }}
    >
      {item.icon && (
        <span className="context-menu__icon" aria-hidden="true">
          {item.icon}
        </span>
      )}
      <span>{item.label}</span>
      {submenu && (
        <ChevronRight
          className="context-menu__chevron"
          size={14}
          aria-hidden="true"
        />
      )}
    </button>
  );

  if (!submenu) return button;
  return (
    <div className="context-menu__host">
      {button}
      {expanded && (
        <MenuList
          items={submenu}
          label={item.label}
          nested
          autoFocus={autoFocusSubmenu}
          onClose={onClose}
          onDismiss={dismissSubmenu}
        />
      )}
    </div>
  );
}

function MenuList({
  items,
  label,
  onClose,
  menuRef,
  style,
  nested = false,
  autoFocus = false,
  onDismiss,
}: {
  items: ContextMenuItem[];
  label: string;
  onClose: () => void;
  menuRef?: RefObject<HTMLDivElement | null>;
  style?: CSSProperties;
  nested?: boolean;
  autoFocus?: boolean;
  onDismiss?: () => void;
}) {
  const fallbackRef = useRef<HTMLDivElement>(null);
  const ref = menuRef ?? fallbackRef;
  const [open, setOpen] = useState<OpenSubmenu>();
  // A flyout that would hang off the right edge opens to the left instead, and one
  // that would run past the bottom slides up by the overflow.
  const [adjust, setAdjust] = useState({ flip: false, shift: 0 });

  useLayoutEffect(() => {
    if (!nested) return;
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const gap = 8;
    const overflow = rect.bottom - (window.innerHeight - gap);
    setAdjust({
      flip: rect.right > window.innerWidth - gap,
      shift: overflow > 0 ? -overflow : 0,
    });
  }, [nested, ref]);

  const ownButtons = useCallback(
    () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? [],
      ).filter((button) => button.closest(".context-menu") === ref.current),
    [ref],
  );

  useEffect(() => {
    if (nested && autoFocus) ownButtons()[0]?.focus();
    // Focusing once on open is the whole point; re-running would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const moveFocus = (delta: number, absolute?: "first" | "last") => {
    const buttons = ownButtons();
    if (!buttons.length) return;
    if (absolute) {
      (absolute === "first"
        ? buttons[0]
        : buttons[buttons.length - 1]
      )?.focus();
      return;
    }
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    buttons[(current + delta + buttons.length) % buttons.length]?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (nested && onDismiss) onDismiss();
      else onClose();
    } else if (event.key === "Tab") {
      // Dismiss the menu but leave Tab's default action intact. The ContextMenu
      // cleanup restores focus to the opener before the browser advances to the
      // next/previous focusable control, so keyboard users can continue through
      // the page instead of being trapped on the trigger.
      onClose();
    } else if (event.key === "ArrowLeft" && nested && onDismiss) {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(0, "first");
    } else if (event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(0, "last");
    }
  };

  return (
    <div
      ref={ref}
      className={`context-menu${nested ? " context-menu--nested" : ""}`}
      role="menu"
      aria-label={label}
      data-flip={nested && adjust.flip ? "true" : undefined}
      style={
        nested
          ? { transform: `translateY(${adjust.shift}px)`, ...style }
          : style
      }
      onKeyDown={handleKeyDown}
    >
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.separated && <hr className="context-menu__separator" />}
          <MenuRow
            item={item}
            expanded={open?.label === item.label}
            autoFocusSubmenu={open?.label === item.label && open.focus}
            onOpenSubmenu={(focus) => setOpen({ label: item.label, focus })}
            onCloseSubmenu={() => setOpen(undefined)}
            onClose={onClose}
          />
        </Fragment>
      ))}
    </div>
  );
}

export function ContextMenu({
  x,
  y,
  label,
  items,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ left: x, top: y, ready: false });
  // Fixed for the life of the menu: changing a portal target remounts its
  // contents, which would throw away focus mid-interaction.
  const [host] = useState(overlayPortalTarget);

  // Measure after the first paint so a menu opened near an edge folds back on screen
  // rather than being clipped.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    const gap = 8;
    // The menu is portaled into whatever owns the top layer, which may itself
    // be the containing block for fixed-position children.
    const offset = fixedPositionOffset(host);
    setPlacement({
      left:
        Math.max(gap, Math.min(x, window.innerWidth - width - gap)) -
        offset.left,
      top:
        Math.max(gap, Math.min(y, window.innerHeight - height - gap)) -
        offset.top,
      ready: true,
    });
  }, [host, x, y]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    // The menu is pinned to viewport coordinates, so anything that moves the page under it
    // dismisses it instead of leaving it stranded.
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div className="context-menu-layer">
      <div
        className="context-menu__backdrop"
        aria-hidden="true"
        onPointerDown={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <MenuList
        menuRef={ref}
        items={items}
        label={label}
        onClose={onClose}
        style={{
          left: placement.left,
          top: placement.top,
          visibility: placement.ready ? undefined : "hidden",
        }}
      />
    </div>,
    host,
  );
}
