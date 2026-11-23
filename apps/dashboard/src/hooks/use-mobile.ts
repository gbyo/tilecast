import { useMediaQuery } from "./use-media-query";

// The sidebar primitive calls this state "mobile", but it is really the
// off-canvas navigation boundary. Keep navigation off-canvas until the
// viewport can fit both Tilecast's 16rem sidebar and a roughly 1024px desktop
// workspace. This avoids enabling desktop editors and then immediately taking
// a quarter of their usable width away.
const MOBILE_QUERY = "(max-width: 1279px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot() {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

export function useIsMobile() {
  return useMediaQuery(MOBILE_QUERY);
}
