import { PlayerAPIError, type PlayerAPI } from "./api";
import { browserSupportsCommand, BROWSER_COMMANDS } from "./capabilities.gen";
import type {
  CapabilityProviderRegistry,
  TypedCapabilityResult,
} from "./capability-providers";
import { completed, result as requestResult } from "./storage/database";

/**
 * Operator commands for a Browser Player, over the same server contract every
 * Player uses: `GET /api/v1/player/commands`, then acknowledge, then a result.
 * There is no command language of the Browser's own. A command type is run
 * only if the generated capability matrix lists it. Anything else is refused
 * with the standard `unsupported_command` result.
 *
 * A command runs at most once. Its idempotency key is stored before it runs
 * and its result is stored before it is reported, so a reload, a lost result
 * or a repeated delivery re-reports what happened and never repeats it.
 */
export interface PlayerCommand {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  idempotencyKey: string;
  state: string;
}

export interface CommandResult {
  success: boolean;
  code: string;
  message: string;
}

export type CommandHandler = (command: PlayerCommand) => Promise<CommandResult>;

/** How many finished commands are remembered per Screen. */
export const REMEMBERED_COMMANDS = 200;

interface StoredCommand {
  slotId: string;
  key: string;
  commandId: string;
  type: string;
  status: "running" | "done";
  result?: CommandResult;
  at: number;
}

export class CommandStore {
  constructor(
    private readonly database: IDBDatabase,
    private readonly slotId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<StoredCommand | undefined> {
    return requestResult(
      this.database
        .transaction("commands")
        .objectStore("commands")
        .get([this.slotId, key]),
    ) as Promise<StoredCommand | undefined>;
  }

  async put(entry: Omit<StoredCommand, "slotId" | "at">): Promise<void> {
    const transaction = this.database.transaction("commands", "readwrite", {
      durability: "strict",
    });
    const done = completed(transaction);
    const store = transaction.objectStore("commands");
    store.put({ ...entry, slotId: this.slotId, at: this.now() }, [
      this.slotId,
      entry.key,
    ]);
    const all = await requestResult(
      store.getAll(IDBKeyRange.bound([this.slotId, ""], [this.slotId, "￿"])),
    );
    const surplus = (all as StoredCommand[])
      .sort((a, b) => a.at - b.at)
      .slice(0, Math.max(0, all.length - REMEMBERED_COMMANDS));
    for (const old of surplus) store.delete([this.slotId, old.key]);
    await done;
  }

  async clear(): Promise<void> {
    const transaction = this.database.transaction("commands", "readwrite");
    const done = completed(transaction);
    transaction
      .objectStore("commands")
      .delete(IDBKeyRange.bound([this.slotId, ""], [this.slotId, "￿"]));
    await done;
  }
}

const cap = (value: string, length: number) => value.slice(0, length);

export const commandResult = (
  success: boolean,
  code: string,
  message = "",
): CommandResult => ({
  success,
  code: cap(code, 80),
  message: cap(message, 240),
});

const providerOutcome = (routed: TypedCapabilityResult): CommandResult =>
  commandResult(routed.success, routed.code, routed.message ?? "");

export class CommandRunner {
  constructor(
    private readonly api: PlayerAPI,
    private readonly store: CommandStore,
    private readonly handlers: ReadonlyMap<string, CommandHandler>,
    private readonly capabilities?: CapabilityProviderRegistry,
  ) {}

  /** Fetches and handles every pending command, in the order the server lists them. */
  async poll(): Promise<number> {
    const { items } = await this.api.request<{ items: PlayerCommand[] }>(
      "/api/v1/player/commands",
    );
    for (const command of items) await this.handle(command);
    return items.length;
  }

  private async handle(command: PlayerCommand): Promise<void> {
    const known = await this.store.get(command.idempotencyKey);
    if (known) {
      // The server is still waiting for this command, so its result was lost.
      // Say what happened. Never run it again.
      const result =
        known.status === "done" && known.result
          ? known.result
          : commandResult(
              false,
              "interrupted",
              "The Browser Player restarted while it ran this command.",
            );
      if (known.status === "running") {
        await this.store.put({
          key: known.key,
          commandId: known.commandId,
          type: known.type,
          status: "done",
          result,
        });
      }
      await this.report(command, result);
      return;
    }
    try {
      await this.api.request(
        `/api/v1/player/commands/${command.id}/acknowledge`,
        {},
      );
    } catch (error) {
      // An expired or already finished command cannot be acknowledged. Skip it.
      if (error instanceof PlayerAPIError && error.status === 409) return;
      throw error;
    }
    const handler = browserSupportsCommand(command.type)
      ? this.handlers.get(command.type)
      : undefined;
    const base = {
      key: command.idempotencyKey,
      commandId: command.id,
      type: command.type,
    };
    if (!handler && this.capabilities) {
      // A provider-backed command (for example a Companion display
      // operation) runs through the registry, with the same
      // store-before-report durability as a static handler.
      const routed = await this.capabilities.invokeCommand(
        command.type,
        command.payload,
      );
      if (routed !== undefined) {
        const outcome = providerOutcome(routed);
        await this.store.put({ ...base, status: "done", result: outcome });
        await this.report(command, outcome);
        return;
      }
    }
    if (!handler) {
      const unsupported = commandResult(
        false,
        "unsupported_command",
        `Browser Player does not support ${command.type}.`,
      );
      await this.store.put({ ...base, status: "done", result: unsupported });
      await this.report(command, unsupported);
      return;
    }
    // Written before the handler runs: a restart in the middle is reported as
    // interrupted instead of running the command a second time.
    await this.store.put({ ...base, status: "running" });
    let outcome: CommandResult;
    try {
      outcome = await handler(command);
    } catch (error) {
      outcome = commandResult(
        false,
        "command_failed",
        error instanceof Error ? error.message : "The command failed.",
      );
    }
    await this.store.put({ ...base, status: "done", result: outcome });
    await this.report(command, outcome);
  }

  private async report(
    command: PlayerCommand,
    outcome: CommandResult,
  ): Promise<void> {
    try {
      await this.api.request(
        `/api/v1/player/commands/${command.id}/result`,
        outcome,
      );
    } catch (error) {
      // The server no longer accepts a result for a settled command.
      if (error instanceof PlayerAPIError && error.status === 409) return;
      throw error;
    }
  }
}

/** Every command type a Browser Player claims has a handler, and no other does. */
export function handlerGaps(
  handlers: ReadonlyMap<string, CommandHandler>,
): string[] {
  const supported = new Set(BROWSER_COMMANDS.map((command) => command.type));
  return [
    ...[...supported].filter((type) => !handlers.has(type)),
    ...[...handlers.keys()].filter((type) => !supported.has(type)),
  ];
}

/** What the Host can do for an operator. Each answer is a fact, not a guess. */
export interface CommandControls {
  /** Reconciles the manifest, configuration and server selection now. */
  syncNow(): Promise<void>;
  /** Activates the current content again. False when nothing is playing. */
  reloadPlayback(): Promise<boolean>;
  /** Asks the shared Runtime to restart the item on screen. */
  retryItem(): boolean;
  /** Asks the shared Runtime to advance. */
  skipItem(): boolean;
  /** Shows the Screen name through the shared Runtime. */
  identify(durationSeconds: number): boolean;
}

const notReady = () =>
  commandResult(false, "renderer_not_ready", "No content is playing.");

export function browserCommandHandlers(
  controls: CommandControls,
): Map<string, CommandHandler> {
  return new Map<string, CommandHandler>([
    [
      "sync_now",
      async () => {
        await controls.syncNow();
        return commandResult(true, "synchronized");
      },
    ],
    [
      "reload_playback",
      async () =>
        (await controls.reloadPlayback())
          ? commandResult(true, "playback_reloaded")
          : notReady(),
    ],
    [
      "identify_screen",
      async (command) => {
        const requested = Number(command.payload?.["durationSeconds"] ?? 15);
        const seconds = Math.min(
          120,
          Math.max(5, Number.isFinite(requested) ? requested : 15),
        );
        return controls.identify(seconds)
          ? commandResult(true, "identified")
          : commandResult(
              false,
              "renderer_not_ready",
              "The display is not ready.",
            );
      },
    ],
    [
      "retry_current_item",
      async () =>
        controls.retryItem() ? commandResult(true, "retried") : notReady(),
    ],
    [
      "skip_current_item",
      async () =>
        controls.skipItem() ? commandResult(true, "skipped") : notReady(),
    ],
  ]);
}
