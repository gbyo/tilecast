/**
 * MIGRATION ONLY. Runtime renderers that still live in this package until
 * their plugins move (Emergency Alerts in milestone 5). Discovery checks each
 * against its plugin's manifest exactly as it checks
 * plugins/<name>/runtime/index.ts, so the host cannot tell them apart. Delete
 * an entry when its plugin moves.
 */
import type { RuntimePluginDefinition } from "@tilecast/plugin-sdk/runtime";
import alertTicker from "./alert-ticker";

export const temporaryAdapters: readonly RuntimePluginDefinition[] = [
  alertTicker,
];
