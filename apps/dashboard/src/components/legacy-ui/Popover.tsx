import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";
import { fixedPositionOffset, overlayPortalTarget } from "./overlayPortal";

/**
 * An anchored floating surface: one contract for positioning, dismissal, and
 * trigger semantics.
 *
 * Studio grew seven of these independently — the account menu, the topbar
 * notification and create menus, three "more filters" panels, and the schedule
 * timezone picker — and each learned a different subset of the behaviour. Two
 * were `<details>` elements, which cannot close on an outside click at all, and
 * the timezone picker could only be dismissed by choosing a timezone. This owns
 * the mechanics so a consumer only supplies a trigger and a panel.
 *
 * Two modes, because they are not the same contract:
 *
 * - `menu` is the ARIA menu pattern. The surface is a `role="menu"`, focus moves
 *   to the first item on open, Arrow/Home/End move between items, and Tab
 *   leaves. Its children must be menu items and nothing else.
 * - `form` is a labelled non-modal `dialog` holding real form controls. It makes
 *   no menu claim, Arrow keys belong to the controls inside it, and Tab cycles
 *   within the surface because the panel is portaled and therefore is not next
 *   in document order after its trigger.
 *
 * The panel is portaled and positioned against the viewport rather than being an
 * absolutely-positioned sibling. That is what lets it escape a clipping ancestor,
 * fold back on screen near a viewport edge, and share the top layer with a modal
 * dialog it was opened from.
 */
export type PopoverMode = "menu" | "form";

/** Spread onto the control that opens the surface. */
export type PopoverTriggerProps = {
  "aria-expanded": boolean;
  "aria-haspopup": "menu" | "dialog";
  "aria-controls": string | undefined;
  onClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
};

// `Select` keeps a hidden native control beside its visible trigger for form
// semantics. It is not tab-focusable, so counting it would put the surface's
// last stop on an element the reader can never reach.
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
const UNREACHABLE = '[tabindex="-1"], [aria-hidden="true"]';

const MENU_ITEM =
  '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])';

/**
 * A `Select` menu and a context menu portal to the document, so a pointer press
 * inside one lands outside this panel in the DOM. Dismissing there would unmount
 * the panel before the option's own click could run, and Escape there belongs to
 * whichever surface is on top rather than to this one.
 *
 * Only the floating parts qualify. A `Select`'s *trigger* sits inside this panel,
 * and Escape with focus on it is the reader asking to leave the panel — the
 * select has already closed.
 */
const NESTED_OVERLAY =
  ".signal-select__menu, .context-menu, .context-menu__backdrop";

/**
 * Everything inside `panel` a Tab press can reach, in the order it will reach
 * them.
 *
 * The order matters: the first and last entries decide where Tab wraps. It is
 * collected by walking the subtree rather than by handing `querySelectorAll` a
 * selector list, because a selector list is only document-ordered in engines
 * that follow the DOM spec here — jsdom's groups its matches by selector, which
 * would put a trailing button ahead of the fields above it and wrap Tab in the
 * middle of the panel.
 */
function focusableWithin(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>("*")).filter(
    (element) => element.matches(FOCUSABLE) && !element.matches(UNREACHABLE),
  );
}

function isInsideNestedOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(NESTED_OVERLAY));
}

/**
 * Escape belongs to the frontmost floating surface. Asking the document rather
 * than inspecting focus keeps that true regardless of where a nested overlay
 * chose to put focus while it was open.
 */
function isNestedOverlayOpen(): boolean {
  return document.querySelector(NESTED_OVERLAY) !== null;
}

export function Popover({
  label,
  trigger,
  children,
  mode = "form",
  align = "start",
  width,
  matchTriggerWidth = false,
  className = "",
  panelClassName = "",
  onOpenChange,
}: {
  /** Accessible name for the surface. Required: it is the only name it gets. */
  label: string;
  trigger: (props: PopoverTriggerProps) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  mode?: PopoverMode;
  /** Which trigger edge the panel lines up with before viewport clamping. */
  align?: "start" | "end";
  /** A CSS length for the panel. Clamped to the viewport by the shared max-width. */
  width?: string;
  /** Size the panel to its trigger, for a picker that replaces a field. */
  matchTriggerWidth?: boolean;
  className?: string;
  panelClassName?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const panelId = `popover-${useId()}`;
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties>();
  const [host, setHost] = useState<HTMLElement>();
  const location = useLocation();

  const triggerElement = useCallback(
    () => anchorRef.current?.querySelector<HTMLElement>("button, a[href]"),
    [],
  );

  /** Dismiss, and by default put focus back on the trigger the reader came from. */
  const close = useCallback(
    (restoreFocus = true) => {
      setOpen(false);
      if (restoreFocus) triggerElement()?.focus();
    },
    [triggerElement],
  );

  // Reported from the state rather than from each caller, so a dismissal the
  // component decides on its own — a route change, a scroll — is announced too.
  const reported = useRef(open);
  useEffect(() => {
    if (reported.current === open) return;
    reported.current = open;
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  // The host is resolved once per opening: changing a portal target remounts the
  // subtree, which would throw away focus mid-interaction.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(undefined);
      setHost(undefined);
      return;
    }
    setHost(overlayPortalTarget(anchorRef.current));
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !host) return;
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const bounds = anchor.getBoundingClientRect();
    const offset = fixedPositionOffset(host);
    const gap = 8;

    // The panel's height depends on its width, and on the first pass it has not
    // been placed yet, so it is measured at a known origin with its final width
    // already applied. This runs before paint, so the probe is never visible.
    const resolvedWidth = matchTriggerWidth ? `${bounds.width}px` : width;
    if (resolvedWidth) panel.style.width = resolvedWidth;
    const measured = panel.getBoundingClientRect();

    // Below unless the panel genuinely does not fit there and there is more room
    // above, so a filter panel near the bottom of a short window opens upward
    // instead of being cut off.
    const spaceBelow = window.innerHeight - bounds.bottom - gap;
    const spaceAbove = bounds.top - gap;
    const flip = measured.height > spaceBelow && spaceAbove > spaceBelow;

    const panelWidth = measured.width || bounds.width;
    const preferred = align === "end" ? bounds.right - panelWidth : bounds.left;
    const left = Math.max(
      gap,
      Math.min(preferred, window.innerWidth - panelWidth - gap),
    );

    setPlacement({
      left: left - offset.left,
      ...(resolvedWidth ? { width: resolvedWidth } : {}),
      maxHeight: Math.max(160, (flip ? spaceAbove : spaceBelow) - gap),
      // Exactly one vertical edge is anchored. The stylesheet's `top: 0` is the
      // pre-measurement origin, and leaving it in place alongside `bottom` would
      // make a flipped panel stretch from the top of the viewport down to the
      // trigger instead of sizing to its content.
      ...(flip
        ? {
            top: "auto",
            bottom: window.innerHeight - bounds.top + 4 - offset.bottom,
          }
        : { top: bounds.bottom + 4 - offset.top, bottom: "auto" }),
    });
  }, [align, host, matchTriggerWidth, open, width]);

  // Move focus in. The panel is portaled, so Tab from the trigger would
  // otherwise skip straight past everything inside it.
  useEffect(() => {
    if (!open || !host) return;
    const panel = panelRef.current;
    if (!panel) return;
    const first =
      mode === "menu"
        ? panel.querySelector<HTMLElement>(MENU_ITEM)
        : focusableWithin(panel)[0];
    // A panel with nothing focusable still needs to be reachable by a screen
    // reader, so the surface itself takes focus.
    (first ?? panel).focus();
  }, [host, mode, open]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (isInsideNestedOverlay(target)) return;
      if (anchorRef.current?.contains(target ?? null)) return;
      if (panelRef.current?.contains(target ?? null)) return;
      // A pointer press elsewhere is a deliberate move away from this surface,
      // and focus follows the press, so nothing is stranded by not restoring it.
      close(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (isNestedOverlayOpen()) return;
      event.preventDefault();
      close();
    };
    // Pinned to viewport coordinates: anything that moves the trigger out from
    // under the panel dismisses it rather than leaving it stranded. Scrolling
    // the panel's own content is not that.
    const dismissOnScroll = (event: Event) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      close(false);
    };
    const dismissOnResize = () => close(false);
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("resize", dismissOnResize);
    window.addEventListener("scroll", dismissOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", dismissOnResize);
      window.removeEventListener("scroll", dismissOnScroll, true);
    };
  }, [close, open]);

  // Navigating away leaves the trigger behind; the panel must not outlive it.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const moveMenuFocus = (delta: number, absolute?: "first" | "last") => {
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? [],
    );
    if (!items.length) return;
    if (absolute) {
      (absolute === "first" ? items[0] : items[items.length - 1])?.focus();
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLElement);
    items[(current + delta + items.length) % items.length]?.focus();
  };

  /** Tab must not escape a portaled panel into the wrong part of the page. */
  const wrapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = focusableWithin(panel);
    if (focusable.length < 2) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last?.focus();
    }
  };

  const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isInsideNestedOverlay(event.target)) return;
    if (event.key === "Tab") {
      if (mode === "menu") {
        event.preventDefault();
        close();
        return;
      }
      wrapTab(event);
      return;
    }
    if (mode !== "menu") return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveMenuFocus(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveMenuFocus(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveMenuFocus(0, "first");
    } else if (event.key === "End") {
      event.preventDefault();
      moveMenuFocus(0, "last");
    }
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (open || mode !== "menu") return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setOpen(true);
  };

  return (
    <span ref={anchorRef} className={`signal-popover ${className}`.trim()}>
      {trigger({
        "aria-expanded": open,
        "aria-haspopup": mode === "menu" ? "menu" : "dialog",
        "aria-controls": open ? panelId : undefined,
        onClick: () => setOpen((current) => !current),
        onKeyDown: handleTriggerKeyDown,
      })}
      {open &&
        host &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            className={`signal-popover__panel ${panelClassName}`.trim()}
            role={mode === "menu" ? "menu" : "dialog"}
            aria-label={label}
            aria-modal={mode === "menu" ? undefined : false}
            tabIndex={-1}
            style={{
              ...placement,
              // Hidden for the frame between mounting and being measured, so it
              // is never painted at the wrong place first.
              visibility: placement ? undefined : "hidden",
            }}
            onKeyDown={handlePanelKeyDown}
          >
            {typeof children === "function"
              ? children(() => close())
              : children}
          </div>,
          host,
        )}
    </span>
  );
}
