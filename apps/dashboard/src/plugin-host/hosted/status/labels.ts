import { useTranslation } from "react-i18next";
import { isKnown, knownFailures, knownKinds } from "./model";

/** Words for the stable codes of the delivery queue. */
export function useDeliveryLabels() {
  const { t } = useTranslation("plugins");
  return {
    failure: (code: string) =>
      isKnown(knownFailures, code) ? t(`hosted.status.failures.${code}`) : code,
    kind: (kind: string) =>
      isKnown(knownKinds, kind) ? t(`hosted.status.kinds.${kind}`) : kind,
  };
}
