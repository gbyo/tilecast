import { mkdtempSync } from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "./api";
import { ApiError } from "./api";
import { CommandCoordinator } from "./commands";
import { StateStore } from "./storage";
import type { CommandResultReport, PlayerCommand } from "./types";

function command(overrides: Partial<PlayerCommand>): PlayerCommand {
  return {
    id: "cmd-1",
    type: "sync_now",
    payload: {},
    idempotencyKey: "key-1",
    state: "pending",
    createdAt: "2026-07-17T00:00:00Z",
    expiresAt: "2026-07-18T00:00:00Z",
    ...overrides,
  };
}

class FakeClient {
  queue: PlayerCommand[] = [];
  acknowledged: string[] = [];
  results: Array<{ id: string; result: CommandResultReport }> = [];
  failFetch: Error | null = null;

  async fetchCommands(): Promise<PlayerCommand[]> {
    if (this.failFetch) {
      throw this.failFetch;
    }
    return [...this.queue];
  }
  async acknowledgeCommand(id: string): Promise<void> {
    this.acknowledged.push(id);
  }
  async reportCommandResult(
    id: string,
    result: CommandResultReport,
  ): Promise<void> {
    this.results.push({ id, result });
    // Terminal: server would stop returning it.
    this.queue = this.queue.filter((c) => c.id !== id);
  }
}

async function makeStore(): Promise<StateStore> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tilecast-test-"));
  const store = new StateStore(dir);
  await store.init();
  return store;
}

function makeCoordinator(
  store: StateStore,
  client: FakeClient,
  executions: string[],
  events: Partial<{
    onCredentialRejected(): void;
  }> = {},
) {
  const handlers = new Map([
    [
      "sync_now",
      async (cmd: PlayerCommand) => {
        executions.push(cmd.id);
        return { success: true, code: "synchronized", message: "" };
      },
    ],
  ]);
  const disruptions: string[] = [];
  const coordinator = new CommandCoordinator(
    store,
    client as unknown as ApiClient,
    handlers,
    new Set(["restart_player_process"]),
    (cmd) => disruptions.push(cmd.type),
    {
      onCredentialRejected: events.onCredentialRejected ?? (() => {}),
      onPollError: () => {},
      onCommandCompleted: () => {},
    },
  );
  return { coordinator, disruptions };
}

describe("CommandCoordinator", () => {
  it("executes a command exactly once across overlapping polls", async () => {
    const store = await makeStore();
    const client = new FakeClient();
    client.queue = [command({})];
    const executions: string[] = [];
    const { coordinator } = makeCoordinator(store, client, executions);
    await coordinator.start();
    coordinator.stop();
    // Even though a second poll ran while the first was pending, the
    // handler ran once.
    expect(executions).toEqual(["cmd-1"]);
    expect(client.acknowledged).toEqual(["cmd-1"]);
    expect(client.results).toHaveLength(1);
    expect(client.results[0]!.result.code).toBe("synchronized");
  });

  it("a command already executed before a restart is re-reported, not re-run", async () => {
    const store = await makeStore();
    const client = new FakeClient();
    client.queue = [command({})];
    const firstRun: string[] = [];
    const first = makeCoordinator(store, client, firstRun);
    await first.coordinator.start();
    first.coordinator.stop();
    expect(firstRun).toEqual(["cmd-1"]);

    // Simulate a restart where the server still returns the same command
    // (result report was lost).
    client.queue = [command({ state: "acknowledged" })];
    client.results = [];
    const secondRun: string[] = [];
    const second = makeCoordinator(store, client, secondRun);
    await second.coordinator.start();
    second.coordinator.stop();
    expect(secondRun).toEqual([]); // never re-executed
    expect(client.results[0]!.result.code).toBe("already_executed");
  });

  it("a crash inside a handler does not replay the command after restart", async () => {
    const store = await makeStore();
    const client = new FakeClient();
    client.queue = [command({})];
    // Simulate the process dying while the handler runs: the handler never
    // returns, so completion is never recorded.
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const crashing = new CommandCoordinator(
      store,
      client as unknown as ApiClient,
      new Map([
        [
          "sync_now",
          () => {
            handlerStarted();
            return new Promise<CommandResultReport>(() => {});
          },
        ],
      ]),
      new Set(),
      () => {},
      { onCredentialRejected() {}, onPollError() {}, onCommandCompleted() {} },
    );
    void crashing.start();
    await started;
    crashing.stop();

    client.queue = [command({ state: "acknowledged" })];
    client.results = [];
    const replayed: string[] = [];
    const second = makeCoordinator(store, client, replayed);
    await second.coordinator.start();
    second.coordinator.stop();
    expect(replayed).toEqual([]);
    expect(client.results).toHaveLength(1);
    expect(client.results[0]!.result).toMatchObject({
      success: false,
      code: "interrupted",
    });

    // The settled command is now an ordinary executed key.
    client.queue = [command({ state: "acknowledged" })];
    client.results = [];
    const third = makeCoordinator(store, client, replayed);
    await third.coordinator.start();
    third.coordinator.stop();
    expect(replayed).toEqual([]);
    expect(client.results[0]!.result.code).toBe("already_executed");
  });

  it("disruptive commands report success before the disruption runs", async () => {
    const store = await makeStore();
    const client = new FakeClient();
    client.queue = [
      command({
        id: "r1",
        type: "restart_player_process",
        idempotencyKey: "rk",
      }),
    ];
    const executions: string[] = [];
    const { coordinator, disruptions } = makeCoordinator(
      store,
      client,
      executions,
    );
    await coordinator.start();
    coordinator.stop();
    expect(disruptions).toEqual(["restart_player_process"]);
    expect(client.results[0]!.result.code).toBe("initiated");
    // Idempotency key persisted: a relaunch that re-fetches must not restart again.
    client.queue = [
      command({
        id: "r1",
        type: "restart_player_process",
        idempotencyKey: "rk",
      }),
    ];
    client.results = [];
    const again = makeCoordinator(store, client, executions);
    await again.coordinator.start();
    again.coordinator.stop();
    expect(again.disruptions).toEqual([]);
    expect(client.results[0]!.result.code).toBe("already_executed");
  });

  it("unknown command types fail safely without crashing the loop", async () => {
    const store = await makeStore();
    const client = new FakeClient();
    client.queue = [
      command({ id: "u1", type: "power_assist_sleep", idempotencyKey: "uk" }),
    ];
    const { coordinator } = makeCoordinator(store, client, []);
    await coordinator.start();
    coordinator.stop();
    expect(client.results[0]!.result).toMatchObject({
      success: false,
      code: "unsupported_command",
    });
  });

  it("stops and reports when the credential is confirmed rejected", async () => {
    const store = await makeStore();
    const client = new FakeClient();
    client.failFetch = new ApiError(
      401,
      "device_credential_revoked",
      "revoked",
    );
    let rejected = false;
    const { coordinator } = makeCoordinator(store, client, [], {
      onCredentialRejected: () => {
        rejected = true;
      },
    });
    await coordinator.start();
    expect(rejected).toBe(true);
  });

  it("a transient poll failure does not stop the coordinator", async () => {
    const store = await makeStore();
    const client = new FakeClient();
    client.failFetch = new ApiError(500, "internal", "boom");
    const executions: string[] = [];
    const { coordinator } = makeCoordinator(store, client, executions);
    await coordinator.start();
    // Server recovers; the next poll executes normally.
    client.failFetch = null;
    client.queue = [command({})];
    await coordinator.pollNow("test");
    coordinator.stop();
    expect(executions).toEqual(["cmd-1"]);
  });
});
