import { useEffect, useState, type RefObject } from "react";

/**
 * Fullscreen through the browser where it is allowed; otherwise the pane
 * covers the window. Escape leaves either one and never touches the draft.
 */
export function useFullscreen(target: RefObject<HTMLElement | null>) {
  const [overlay, setOverlay] = useState(false);
  const [native, setNative] = useState(false);
  useEffect(() => {
    const sync = () =>
      setNative(
        document.fullscreenElement !== null &&
          document.fullscreenElement === target.current,
      );
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [target]);
  useEffect(() => {
    if (!overlay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOverlay(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlay]);
  const toggle = () => {
    if (native) {
      void document.exitFullscreen();
      return;
    }
    if (overlay) {
      setOverlay(false);
      return;
    }
    const element = target.current;
    if (element && typeof element.requestFullscreen === "function") {
      element.requestFullscreen().catch(() => setOverlay(true));
    } else {
      setOverlay(true);
    }
  };
  return { active: native || overlay, toggle };
}
