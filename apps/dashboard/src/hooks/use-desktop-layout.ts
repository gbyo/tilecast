import { useMediaQuery } from "./use-media-query";

const DESKTOP_QUERY = "(min-width: 1024px)";

// useDesktopLayout reports whether the viewport is wide enough for the
// multi-pane editor layouts (playlist, layout, and form builders). Editors
// render exactly one branch — the Resizable desktop panes or the
// stacked/Sheet narrow fallback — so control ids are never duplicated.
export function useDesktopLayout() {
  return useMediaQuery(DESKTOP_QUERY);
}
