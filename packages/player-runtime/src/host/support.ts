import type { RuntimeSupportV1 } from "./contract";
import { SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES } from "../compat/projection/presentation-capabilities.gen";
import { COMPONENT_PRESENTATION_SCHEMA_VERSION } from "../widgets/capabilities.gen";
import {
  PLAYER_PLUGIN_HOST_CAPABILITY,
  PLAYER_PLUGIN_HOST_VERSION,
} from "@tilecast/plugin-sdk/services";
import {
  EXTERNAL_RUNTIME_CAPABILITY,
  EXTERNAL_RUNTIME_FRAME_VERSION,
} from "../widgets/projection";

/**
 * The caller supplies capabilities from the running Widget discovery
 * registry and, when the host forwards Plugin API v2 state, the running
 * Player service registry. Without a forwarding host the v2 plugin host and
 * its services are not reported, so the Server sends no plugin_state.
 */
export function runtimeSupport(
  widgetComponents: Record<string, number>,
  remoteWeb: boolean,
  externalFrames = false,
  externalPluginFrames = false,
  playerServices: Readonly<Record<string, number>> | null = null,
): RuntimeSupportV1 {
  return {
    presentationSchemas: [1, 2, COMPONENT_PRESENTATION_SCHEMA_VERSION],
    declarativeCapabilities: {
      ...SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES,
      ...(remoteWeb ? { "web.remote": 2 } : {}),
      ...(externalPluginFrames ? { "plugin.external-runtime": 1 } : {}),
      ...(playerServices
        ? {
            ...playerServices,
            [PLAYER_PLUGIN_HOST_CAPABILITY]: PLAYER_PLUGIN_HOST_VERSION,
          }
        : {}),
    },
    widgetComponents: {
      ...widgetComponents,
      // The frame execution ABI is one capability for every downloaded
      // Widget; downloaded types never join this list.
      ...(externalFrames
        ? { [EXTERNAL_RUNTIME_CAPABILITY]: EXTERNAL_RUNTIME_FRAME_VERSION }
        : {}),
    },
  };
}
