import { useNativeMediaIntakeRefresh } from "./useNativeMediaIntake";

/** Refetches media when native intake finishes. Renders nothing. */
export function NativeMediaIntakeRefresh() {
  useNativeMediaIntakeRefresh();
  return null;
}
