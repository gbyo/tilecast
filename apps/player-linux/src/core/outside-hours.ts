import {
  buildOutsideActiveHoursPresentation,
  type OutsideActiveHoursPresentation,
} from "@tilecast/player-active-hours";
import type { StateStore } from "./storage";
import type { PlayerConfig } from "./types";

const CONFIG_FILE = "player-config.json";

export {
  buildOutsideActiveHoursPresentation,
  type OutsideActiveHoursDisplay,
  type OutsideActiveHoursPresentation,
} from "@tilecast/player-active-hours";

interface StoredConfig {
  current?: PlayerConfig;
}

/** Read the same atomic cached configuration used by ConfigSync at startup. */
export async function loadOutsideActiveHoursPresentation(
  store: StateStore,
): Promise<OutsideActiveHoursPresentation> {
  const stored = await store.readJson<StoredConfig>(CONFIG_FILE);
  return buildOutsideActiveHoursPresentation(stored?.current);
}
