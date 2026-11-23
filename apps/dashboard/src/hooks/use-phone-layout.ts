import { useMediaQuery } from "./use-media-query";

const PHONE_QUERY = "(max-width: 639px)";

// usePhoneLayout answers a presentation question, not a density question.
// Phone-sized content areas use bottom drawers/full-height compact surfaces.
// iPad-sized medium windows keep the narrow workspace controls from
// useCompactLayout, but have enough room for popovers, dialogs, and side
// panels. Keeping the two decisions separate avoids turning iPad into a
// stretched phone UI.
export function usePhoneLayout() {
  return useMediaQuery(PHONE_QUERY);
}
