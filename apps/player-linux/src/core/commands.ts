/**
 * Persistent command retrieval and execution.
 *
 * Delivery must survive a wedged or absent WebSocket, so the coordinator
 * polls `GET /api/v1/player/commands` on a fixed timer for the life of the
 * player, independent of socket state. The socket's `commands.available`
 * message remains the fast path — it just triggers an immediate poll.
 *
 * Execution is at-most-once per command: a single in-process mutex means
 * overlapping notification and timer polls cannot race, and the idempotency
 * key is persisted as in flight BEFORE the handler runs. A process that
 * dies mid-handler therefore never repeats the side effect when it comes
 * back and re-fetches the command; it reports the interrupted outcome
 * instead, because whether the effect happened is unknown.
 */

import { ApiError, type ApiClient } from "./api";
import { logger } from "./log";
import type { StateStore } from "./storage";
import type { CommandResultReport, PlayerCommand } from "./types";

const log = logger("commands");

const EXECUTED_FILE = "executed-commands.json";
const MAX_REMEMBERED_KEYS = 500;
export const COMMAND_POLL_INTERVAL_MS = 7_000;

export type CommandHandler = (
  command: PlayerCommand,
) => Promise<CommandResultReport>;

/**
 * Handlers that intentionally end the process (restart commands) report a
 * successful result and persist the idempotency key BEFORE the disruptive
 * action runs, then return null to stop the loop.
 */
export type CommandOutcome = CommandResultReport | "handled_before_disruption";

interface ExecutedRecord {
  keys: string[];
  /** Keys whose handler started but whose completion was never recorded. */
  inFlight?: string[];
}

export interface CommandExecutorEvents {
  /** The server proved the credential dead; the owner must re-pair. */
  onCredentialRejected(): void;
  onPollError(error: string): void;
  onCommandCompleted(command: PlayerCommand, result: CommandResultReport): void;
}

export class CommandCoordinator {
  private executed: Set<string> = new Set();
  private inFlight: Set<string> = new Set();
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pollQueued = false;
  private stopped = false;

  constructor(
    private readonly store: StateStore,
    private readonly client: ApiClient,
    private readonly handlers: Map<string, CommandHandler>,
    private readonly disruptiveTypes: Set<string>,
    private readonly disruptiveExecutor: (command: PlayerCommand) => void,
    private readonly events: CommandExecutorEvents,
  ) {}

  async start(): Promise<void> {
    if (!this.loaded) {
      const record = await this.store.readJson<ExecutedRecord>(EXECUTED_FILE);
      this.executed = new Set(record?.keys ?? []);
      this.inFlight = new Set(record?.inFlight ?? []);
      this.loaded = true;
    }
    if (this.timer === null) {
      this.timer = setInterval(() => {
        void this.pollNow("timer");
      }, COMMAND_POLL_INTERVAL_MS);
      // Node keeps the process alive for intervals; that is what we want in
      // a player, but do not block a deliberate quit.
      this.timer.unref?.();
    }
    await this.pollNow("start");
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Fetch and execute pending commands. Serialized: a poll arriving while
   * one is running queues exactly one follow-up pass instead of racing.
   */
  async pollNow(trigger: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.running) {
      this.pollQueued = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.pollQueued = false;
        await this.runOnePass(trigger);
      } while (this.pollQueued && !this.stopped);
    } finally {
      this.running = false;
    }
  }

  private async runOnePass(trigger: string): Promise<void> {
    let commands: PlayerCommand[];
    try {
      commands = await this.client.fetchCommands();
    } catch (err) {
      if (err instanceof ApiError && err.credentialRejected) {
        this.stop();
        this.events.onCredentialRejected();
        return;
      }
      // screen_disabled, 5xx, network: keep polling on the timer.
      this.events.onPollError(String(err));
      return;
    }

    for (const command of commands) {
      if (this.stopped) {
        return;
      }
      await this.executeOne(command, trigger);
    }
  }

  private async executeOne(
    command: PlayerCommand,
    trigger: string,
  ): Promise<void> {
    if (this.inFlight.has(command.idempotencyKey)) {
      // A previous process started this command and died before recording
      // completion. Do not run it again; the effect may or may not have
      // happened, so report that honestly and settle the command.
      await this.rememberExecuted(command.idempotencyKey);
      await this.tryReport(command.id, {
        success: false,
        code: "interrupted",
        message: "player restarted while the command was running",
      });
      return;
    }
    if (this.executed.has(command.idempotencyKey)) {
      // Already ran (possibly before a process restart). Re-report the
      // terminal state so the server can settle; result reporting is
      // idempotent server-side.
      await this.tryReport(command.id, {
        success: true,
        code: "already_executed",
        message: "command was already executed by this player",
      });
      return;
    }

    try {
      await this.client.acknowledgeCommand(command.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Expired or otherwise not acknowledgeable; skip.
        return;
      }
      this.events.onPollError(`acknowledge failed: ${String(err)}`);
      return;
    }

    log.info("executing command", {
      type: command.type,
      id: command.id,
      trigger,
    });

    if (this.disruptiveTypes.has(command.type)) {
      // Persist completion and report success BEFORE the disruption so the
      // relaunched process neither re-executes nor leaves the command
      // dangling in "acknowledged".
      await this.rememberExecuted(command.idempotencyKey);
      await this.tryReport(command.id, {
        success: true,
        code: "initiated",
        message: `${command.type} initiated`,
      });
      this.disruptiveExecutor(command);
      return;
    }

    const handler = this.handlers.get(command.type);
    if (!handler) {
      await this.rememberExecuted(command.idempotencyKey);
      await this.tryReport(command.id, {
        success: false,
        code: "unsupported_command",
        message: `command type ${command.type} is not supported on this platform`,
      });
      return;
    }

    // Durable before the side effect, so a crash inside the handler cannot
    // lead to a second execution after restart.
    await this.markInFlight(command.idempotencyKey);
    let result: CommandResultReport;
    try {
      result = await handler(command);
    } catch (err) {
      result = {
        success: false,
        code: "command_failed",
        message: String(err).slice(0, 240),
      };
    }
    await this.rememberExecuted(command.idempotencyKey);
    await this.tryReport(command.id, result);
    this.events.onCommandCompleted(command, result);
  }

  private async markInFlight(key: string): Promise<void> {
    this.inFlight.add(key);
    await this.persist();
  }

  private async rememberExecuted(key: string): Promise<void> {
    this.inFlight.delete(key);
    this.executed.add(key);
    // Bound the persisted set; oldest first.
    const keys = [...this.executed];
    const trimmed = keys.slice(Math.max(0, keys.length - MAX_REMEMBERED_KEYS));
    this.executed = new Set(trimmed);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const record: ExecutedRecord = { keys: [...this.executed] };
    if (this.inFlight.size > 0) {
      record.inFlight = [...this.inFlight];
    }
    await this.store.writeJson(EXECUTED_FILE, record);
  }

  private async tryReport(
    id: string,
    result: CommandResultReport,
  ): Promise<void> {
    try {
      await this.client.reportCommandResult(id, result);
    } catch (err) {
      // The command stays in acknowledged/delivered; a later poll re-fetches
      // it and the executed-key check re-reports without re-executing.
      log.warn("result report failed; will retry on next poll", {
        id,
        error: String(err),
      });
    }
  }
}
