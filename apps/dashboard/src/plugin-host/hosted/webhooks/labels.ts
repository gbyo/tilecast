import { useTranslation } from "react-i18next";
import { isKnown } from "../status/model";
import {
  knownAuthentications,
  knownHandshakes,
  knownReachability,
  knownRefusals,
  knownSchemes,
  knownSecretStates,
} from "./model";

/** Words for the stable codes of inbound webhooks. */
export function useWebhookLabels() {
  const { t } = useTranslation("plugins");
  return {
    authentication: (code: string) =>
      isKnown(knownAuthentications, code)
        ? t(`hosted.webhooks.authentication.${code}`)
        : code,
    scheme: (code: string) =>
      isKnown(knownSchemes, code) ? t(`hosted.webhooks.schemes.${code}`) : code,
    handshake: (code: string) =>
      isKnown(knownHandshakes, code)
        ? t(`hosted.webhooks.handshakes.${code}`)
        : code,
    reachability: (code: string) =>
      isKnown(knownReachability, code)
        ? t(`hosted.webhooks.reachability.${code}`)
        : code,
    secretState: (code: string) =>
      isKnown(knownSecretStates, code)
        ? t(`hosted.webhooks.secretStates.${code}`)
        : code,
    refusal: (code: string) =>
      isKnown(knownRefusals, code)
        ? t(`hosted.webhooks.refusals.${code}`)
        : code,
  };
}
