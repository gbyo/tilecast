import { useEffect, useEffectEvent } from "react";

function isShortcutTargetInDialog(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest('[role="dialog"],[role="alertdialog"]'))
  );
}

/**
 * Ctrl/Command+S saves from anywhere in the editor except an open dialog,
 * which owns its own keys. The browser's own Save Page never runs.
 *
 * The listener is installed once; an Effect Event hands it the latest save
 * so the shortcut never runs a stale draft.
 */
export function useSaveShortcut(save: () => void, readOnly: boolean) {
  const saveFromShortcut = useEffectEvent(save);
  useEffect(() => {
    if (readOnly) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "s" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing
      )
        return;
      if (isShortcutTargetInDialog(event.target)) return;
      event.preventDefault();
      saveFromShortcut();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [readOnly]);
}

/** The platform's name for the save chord, for tooltips: "⌘ S" or "Ctrl S". */
export function shortcutLabel() {
  if (typeof navigator === "undefined") return "Ctrl S";
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "⌘ S" : "Ctrl S";
}
