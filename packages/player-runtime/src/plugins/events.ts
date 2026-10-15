/**
 * `player.events@1`: ephemeral, typed events between one plugin's native and
 * Shared Runtime parts.
 *
 * An event is not state and not a method call. Each one is declared in the
 * plugin's manifest with a name, a version, and the side that raises it. The
 * payload is a small JSON object within fixed bounds. Delivery is at most
 * once and ends with the plugin: a disposed or failed plugin can neither
 * emit nor receive. Nothing here names a plugin or a platform.
 *
 * The bounds and the message shape equal Player Core's
 * (`crates/player-core/src/plugin_events.rs`); both replay
 * `packages/player-contracts/fixtures/plugin-events.json`.
 */
import type {
  PlayerEventPayload,
  PlayerEventsService,
} from "@tilecast/plugin-sdk/player";
import { PLAYER_EVENT_LIMITS } from "@tilecast/plugin-sdk/player";
import type { PluginEventMessageV1 } from "../host/contract";
import type { PlayerServiceProvider } from "./services";

export const PLUGIN_EVENT_MESSAGE_TYPE = "plugin-event";

const PLUGIN = /^[a-z][a-z0-9_]{0,79}$/;
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const KNOWN = ["type", "plugin", "event", "version", "payload"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Walks the value once: plain JSON only, within the depth and value caps. */
function withinBounds(
  value: unknown,
  depth: number,
  seen: { n: number },
): boolean {
  seen.n += 1;
  if (
    seen.n > PLAYER_EVENT_LIMITS.maxPayloadValues ||
    depth > PLAYER_EVENT_LIMITS.maxPayloadDepth
  )
    return false;
  if (value === null || typeof value === "string") return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item) => withinBounds(item, depth + 1, seen));
  if (isObject(value))
    return Object.values(value).every((field) =>
      withinBounds(field, depth + 1, seen),
    );
  return false;
}

/** A payload is a plain JSON object within the byte, depth, and value caps. */
export function validEventPayload(payload: unknown): boolean {
  if (!isObject(payload)) return false;
  if (!withinBounds(payload, 0, { n: 0 })) return false;
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  return bytes <= PLAYER_EVENT_LIMITS.maxPayloadBytes;
}

/** Parse a wire message strictly: unknown members are refused. */
export function parseEventMessage(value: unknown): PluginEventMessageV1 | null {
  if (!isObject(value)) return null;
  if (
    value["type"] !== PLUGIN_EVENT_MESSAGE_TYPE ||
    Object.keys(value).some((key) => !KNOWN.includes(key))
  )
    return null;
  const { plugin, event, version, payload } = value;
  if (
    typeof plugin !== "string" ||
    !PLUGIN.test(plugin) ||
    typeof event !== "string" ||
    !NAME.test(event) ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > 1000 ||
    !validEventPayload(payload)
  )
    return null;
  return {
    type: PLUGIN_EVENT_MESSAGE_TYPE,
    plugin,
    event,
    version,
    payload: payload as Record<string, unknown>,
  };
}

type Listener = (payload: PlayerEventPayload) => void;

export interface PlayerEventsOptions {
  /** Hand one Runtime event to the native part. Returns false if refused. */
  send(message: PluginEventMessageV1): boolean;
  diagnostic(pluginId: string, message: string): void;
}

export class PlayerEvents {
  /** plugin id → `name@version` → listeners of its live bindings. */
  private readonly listeners = new Map<string, Map<string, Set<Listener>>>();

  constructor(private readonly options: PlayerEventsOptions) {}

  /**
   * One message from the host. Only a listener of an active binding that
   * declared the event receives it. Malformed or undeclared messages are
   * dropped with a diagnostic and never reach a plugin.
   */
  receive(value: unknown): boolean {
    const message = parseEventMessage(value);
    if (!message) {
      this.options.diagnostic("plugin_events", "refused a malformed event");
      return false;
    }
    const set = this.listeners
      .get(message.plugin)
      ?.get(`${message.event}@${message.version}`);
    if (!set || set.size === 0) return false;
    for (const listener of [...set]) listener(message.payload);
    return true;
  }

  provider(): PlayerServiceProvider<PlayerEventsService> {
    return {
      name: "player.events",
      version: 1,
      bind: (context) => {
        const declared = (name: string, version: number, source: string) =>
          context.declaration.events.some(
            (event) =>
              event.name === name &&
              event.version === version &&
              event.source === source,
          );
        const mine: { key: string; listener: Listener }[] = [];
        // A plugin that keeps this handle after disposal gets nothing from it.
        let live = true;
        return {
          api: {
            emit: (name, version, payload) => {
              if (!live) return false;
              if (!declared(name, version, "runtime")) {
                context.report(`event ${name}@${version} is not declared`);
                return false;
              }
              const message = parseEventMessage({
                type: PLUGIN_EVENT_MESSAGE_TYPE,
                plugin: context.pluginId,
                event: name,
                version,
                payload,
              });
              if (!message) {
                context.report(`event ${name}@${version} payload is refused`);
                return false;
              }
              try {
                return this.options.send(message);
              } catch {
                return false;
              }
            },
            on: (name, version, listener) => {
              if (!live) return null;
              if (!declared(name, version, "native")) {
                context.report(`event ${name}@${version} is not declared`);
                return null;
              }
              const key = `${name}@${version}`;
              const guarded: Listener = (payload) =>
                context.guard(() => listener(payload));
              const forPlugin =
                this.listeners.get(context.pluginId) ??
                new Map<string, Set<Listener>>();
              this.listeners.set(context.pluginId, forPlugin);
              const set = forPlugin.get(key) ?? new Set<Listener>();
              forPlugin.set(key, set);
              set.add(guarded);
              mine.push({ key, listener: guarded });
              return () => this.remove(context.pluginId, key, guarded);
            },
          },
          dispose: () => {
            live = false;
            for (const { key, listener } of mine.splice(0)) {
              this.remove(context.pluginId, key, listener);
            }
          },
        };
      },
    };
  }

  private remove(pluginId: string, key: string, listener: Listener): void {
    const forPlugin = this.listeners.get(pluginId);
    forPlugin?.get(key)?.delete(listener);
    if (forPlugin && [...forPlugin.values()].every((set) => set.size === 0)) {
      this.listeners.delete(pluginId);
    }
  }
}
