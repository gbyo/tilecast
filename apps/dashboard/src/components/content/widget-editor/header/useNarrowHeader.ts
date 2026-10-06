import { useLayoutEffect, useState } from "react";
import { useEditorHeaderSlots } from "@/components/studio/EditorHeaderSlots";

/**
 * The room the editor's header controls need: Used by, the save state, Save,
 * and the actions menu sit beside the shell's navigation, search, and
 * notifications. Below this width they collapse into their compact forms.
 */
export const HEADER_FULL_WIDTH = 760;

/**
 * Whether the shell header is too narrow for the full controls. The header
 * shares its row with the sidebar, so its width follows the window and the
 * sidebar together; a viewport breakpoint cannot say whether the controls
 * fit. An unmeasured header (tests, no shell) counts as wide.
 */
export function useNarrowHeader() {
  const slots = useEditorHeaderSlots();
  const slot = slots?.right ?? null;
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const header = slot?.closest("header");
    if (!header) return;
    const measure = () => {
      const width = header.clientWidth;
      setNarrow(width > 0 && width < HEADER_FULL_WIDTH);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [slot]);
  return narrow;
}
