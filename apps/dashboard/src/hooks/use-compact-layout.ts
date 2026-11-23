import { useMediaQuery } from "./use-media-query";

const COMPACT_QUERY = "(max-width: 1023px)";

// useCompactLayout reports a narrow workspace: phones, portrait tablets, and
// constrained iPad windows. It is deliberately the inverse of
// useDesktopLayout's 1024px threshold so there is no 640–1023px tablet
// no-man's-land where each toolbar makes a different density decision.
//
// Toolbars and editors use it to render exactly one progressive-disclosure
// branch, such as a combined View options menu or a stacked editor instead of
// desktop controls. Presentation style is a separate usePhoneLayout decision,
// so iPad-width compact workspaces can still use popovers and side panels.
export function useCompactLayout() {
  return useMediaQuery(COMPACT_QUERY);
}
