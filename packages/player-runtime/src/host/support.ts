import type { RuntimeSupportV1 } from "./contract";
import { SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES } from "../compat/projection/presentation-capabilities.gen";
import { COMPONENT_PRESENTATION_SCHEMA_VERSION } from "../widgets/capabilities.gen";
import {
  EXTERNAL_RUNTIME_CAPABILITY,
  EXTERNAL_RUNTIME_FRAME_VERSION,
} from "../widgets/projection";

/** The caller supplies capabilities from the running Widget discovery registry. */
export function runtimeSupport(
  widgetComponents: Record<string, number>,
  remoteWeb: boolean,
  externalFrames = false,
): RuntimeSupportV1 {
  return {
    presentationSchemas: [1, 2, COMPONENT_PRESENTATION_SCHEMA_VERSION],
    declarativeCapabilities: {
      ...SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES,
      ...(remoteWeb ? { "web.remote": 1 } : {}),
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
