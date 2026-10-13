/** Shared timing actor for Player surfaces and Studio's preview adapters. */
import { createActor } from "xstate";
import { zoneMachine, type ZoneActor, type ZoneInput } from "./zone-machine";
export function createZoneActor(input: ZoneInput): ZoneActor {
  return createActor(zoneMachine, { input });
}
export {
  zoneMachine,
  zoneEntry,
  type ZoneActor,
  type ZoneTimingEntry,
} from "./zone-machine";
export { browserClock } from "../clock/scheduler";
