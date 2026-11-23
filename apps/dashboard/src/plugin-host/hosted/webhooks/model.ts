import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";

/** Whether the host generates a Webhooks page for a plugin. */
export const hasWebhooksPage = (manifest: PluginManifestV3) =>
  (manifest.webhooks ?? []).length > 0;

export const webhooksRoute = (manifest: PluginManifestV3) =>
  `${manifest.studio!.route}/webhooks`;

/** Stable codes Studio explains. Any other code is shown as it is. */
export const knownAuthentications = [
  "token",
  "signature",
  "fetch-back",
] as const;
export const knownSchemes = [
  "standard-webhooks",
  "hmac-sha256",
  "verify",
] as const;
export const knownHandshakes = ["echo-query", "echo-json"] as const;
export const knownReachability = [
  "available",
  "public_https_required",
  "local_network",
  "public_url_missing",
] as const;
export const knownRefusals = [
  "token_invalid",
  "signing_secret_unavailable",
  "signing_secret_unusable",
  "signature_missing",
  "signature_invalid",
  "timestamp_missing",
  "timestamp_out_of_range",
  "delivery_id_missing",
  "verify_failed",
  "verify_timeout",
  "verify_panic",
  "event_id_invalid",
  "rate_limited",
  "queue_full",
  "header_too_large",
  "body_too_large",
  "handshake_value_too_large",
] as const;
export const knownSecretStates = ["set", "not_set", "needs_value"] as const;
