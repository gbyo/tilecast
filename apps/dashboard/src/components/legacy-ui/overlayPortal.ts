/**
 * Where a floating menu should portal to.
 *
 * A modal `<dialog>` is painted in the browser's top layer, which sits above
 * every z-index in the document and makes the rest of the page inert. A menu
 * portaled to `<body>` from a control inside a dialog therefore renders behind
 * that dialog and cannot be clicked at all — no z-index can win, because the
 * top layer is not part of the same stacking context. The fix is to portal into
 * the dialog itself, where the menu shares the top layer with it.
 *
 * `<body>` remains the target when no dialog is open, so menus still escape
 * `overflow: hidden` and transformed ancestors on ordinary pages.
 *
 * An open dialog is treated as the target whether or not it is modal. Studio
 * only ever opens them with `showModal()`, and a non-modal one is harmless: the
 * menu is positioned against the viewport either way.
 */
export function overlayPortalTarget(anchor?: Element | null): HTMLElement {
  const owner = anchor?.closest("dialog");
  if (owner instanceof HTMLDialogElement && owner.open) return owner;
  return topmostOpenDialog() ?? document.body;
}

/**
 * The last open dialog in document order, which is the one on top. Anything
 * beneath a modal dialog is inert, so a menu opened while one is up belongs to
 * that dialog even when the caller has no element to anchor against.
 */
function topmostOpenDialog(): HTMLDialogElement | null {
  const open = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
  return open[open.length - 1] ?? null;
}

/**
 * What to subtract from viewport coordinates so a `position: fixed` menu inside
 * `host` still lands where it was measured.
 *
 * A transform, filter, or paint containment on the host makes it the containing
 * block for its fixed-position descendants, so `top`/`left` are then resolved
 * against the host's padding box instead of the viewport. Dialogs carry a
 * transform for the length of their entry animation, so a menu opened during
 * those milliseconds would otherwise be thrown off by the dialog's own offset.
 */
export function fixedPositionOffset(host: HTMLElement): FixedOffset {
  if (host === document.body || !host.isConnected) return noOffset;
  const style = getComputedStyle(host);
  const containingBlock =
    style.transform !== "none" ||
    style.filter !== "none" ||
    style.perspective !== "none" ||
    style.willChange.includes("transform") ||
    /paint|layout|strict|content/.test(style.contain);
  if (!containingBlock) return noOffset;
  const bounds = host.getBoundingClientRect();
  return {
    left: bounds.left + parseFloat(style.borderLeftWidth || "0"),
    top: bounds.top + parseFloat(style.borderTopWidth || "0"),
    // `bottom` counts inwards from the containing block's bottom edge rather
    // than the viewport's, so it needs the mirrored correction.
    bottom:
      window.innerHeight -
      bounds.bottom +
      parseFloat(style.borderBottomWidth || "0"),
  };
}

export type FixedOffset = { left: number; top: number; bottom: number };

const noOffset: FixedOffset = { left: 0, top: 0, bottom: 0 };
