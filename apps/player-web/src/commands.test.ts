import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { PlayerAPI } from "./api";
import { BROWSER_COMMANDS } from "./capabilities.gen";
import { CapabilityProviderRegistry } from "./capability-providers";
import {
  CommandRunner,
  CommandStore,
  REMEMBERED_COMMANDS,
  browserCommandHandlers,
  commandResult,
  handlerGaps,
  type CommandControls,
  type PlayerCommand,
} from "./commands";
import { openDatabase } from "./storage/database";

(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= IDBKeyRange;

const command = (
  type: string,
  key: string,
  extra: Partial<PlayerCommand> = {},
): PlayerCommand => ({
  id: `command-${key}`,
  type,
  payload: {},
  idempotencyKey: key,
  state: "delivered",
  ...extra,
});

function server(
  pending: () => PlayerCommand[],
  overrides: { ack?: number; result?: number } = {},
) {
  const log: string[] = [];
  const results: Record<string, unknown>[] = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "https://signage.example.org").pathname;
    const ok = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ data }), { status });
    if (path === "/api/v1/player/commands") return ok({ items: pending() });
    log.push(path);
    if (path.endsWith("/acknowledge"))
      return overrides.ack
        ? new Response(JSON.stringify({ error: { code: "command_expired" } }), {
            status: overrides.ack,
          })
        : ok({});
    results.push(JSON.parse(String(init?.body)));
    return overrides.result
      ? new Response(JSON.stringify({ error: { code: "x" } }), {
          status: overrides.result,
        })
      : ok({});
  }) as typeof fetch;
  return { api: new PlayerAPI(transport), log, results };
}

function controls(): CommandControls & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    syncNow: async () => void calls.push("sync"),
    reloadPlayback: async () => (calls.push("reload"), true),
    retryItem: () => (calls.push("retry"), true),
    skipItem: () => (calls.push("skip"), true),
    identify: (seconds) => (calls.push(`identify:${seconds}`), true),
  };
}

async function setup(
  pending: () => PlayerCommand[],
  overrides = {},
  handlers = controls(),
) {
  const database = await openDatabase(new IDBFactory());
  const remote = server(pending, overrides);
  const store = new CommandStore(database, "slot");
  const runner = new CommandRunner(
    remote.api,
    store,
    browserCommandHandlers(handlers),
  );
  return { database, remote, store, runner, handlers };
}

describe("Browser Player commands", () => {
  it("lists exactly the commands the generated matrix supports", () => {
    expect(handlerGaps(browserCommandHandlers(controls()))).toEqual([]);
    expect(BROWSER_COMMANDS.map((entry) => entry.type)).toEqual([
      "sync_now",
      "reload_playback",
      "identify_screen",
      "retry_current_item",
      "skip_current_item",
    ]);
  });

  it("acknowledges, runs and reports a command once", async () => {
    const h = await setup(() => [command("retry_current_item", "k1")]);
    await h.runner.poll();
    expect(h.handlers.calls).toEqual(["retry"]);
    expect(h.remote.log).toEqual([
      "/api/v1/player/commands/command-k1/acknowledge",
      "/api/v1/player/commands/command-k1/result",
    ]);
    expect(h.remote.results).toEqual([
      { success: true, code: "retried", message: "" },
    ]);
  });

  it("does not run a repeated delivery again and reports the original result", async () => {
    const h = await setup(() => [command("skip_current_item", "k1")]);
    await h.runner.poll();
    await h.runner.poll();
    expect(h.handlers.calls).toEqual(["skip"]);
    expect(h.remote.results).toHaveLength(2);
    expect(h.remote.results[1]).toEqual(h.remote.results[0]);
  });

  it("does not run a completed command again after a reload", async () => {
    const database = await openDatabase(new IDBFactory());
    const first = server(() => [command("sync_now", "k1")], { result: 502 });
    const handlers = controls();
    const store = new CommandStore(database, "slot");
    // The result is lost in transit: the server still lists the command.
    await expect(
      new CommandRunner(
        first.api,
        store,
        browserCommandHandlers(handlers),
      ).poll(),
    ).rejects.toBeDefined();
    // A new page load, with the same database.
    const second = server(() => [command("sync_now", "k1")]);
    await new CommandRunner(
      second.api,
      new CommandStore(database, "slot"),
      browserCommandHandlers(handlers),
    ).poll();
    expect(handlers.calls).toEqual(["sync"]);
    expect(second.results).toEqual([
      { success: true, code: "synchronized", message: "" },
    ]);
  });

  it("reports a command a restart interrupted instead of running it twice", async () => {
    const h = await setup(() => [command("reload_playback", "k1")]);
    await h.store.put({
      key: "k1",
      commandId: "command-k1",
      type: "reload_playback",
      status: "running",
    });
    await h.runner.poll();
    expect(h.handlers.calls).toEqual([]);
    expect(h.remote.results[0]).toMatchObject({
      success: false,
      code: "interrupted",
    });
  });

  it("refuses a command a browser cannot perform", async () => {
    const h = await setup(() => [
      command("display_power_off", "k1"),
      command("restart_player_process", "k2"),
      command("install_player_update", "k3"),
    ]);
    await h.runner.poll();
    expect(h.handlers.calls).toEqual([]);
    expect(h.remote.results.map((entry) => entry["code"])).toEqual([
      "unsupported_command",
      "unsupported_command",
      "unsupported_command",
    ]);
    expect(h.remote.results.every((entry) => entry["success"] === false)).toBe(
      true,
    );
  });

  it("routes a provider-backed command through the registry", async () => {
    const database = await openDatabase(new IDBFactory());
    const remote = server(() => [command("display_power_off", "k1")]);
    const registry = new CapabilityProviderRegistry();
    const seen: { operation: string; input: Record<string, unknown> }[] = [];
    registry.add({
      id: "fake-display",
      describe: () => ({
        "display.power": { version: 1, provider: "fake" },
      }),
      invoke: async (operation, input) => {
        seen.push({ operation, input });
        return { success: true, code: "fake_powered_off" };
      },
    });
    const runner = new CommandRunner(
      remote.api,
      new CommandStore(database, "slot"),
      browserCommandHandlers(controls()),
      registry,
    );
    await runner.poll();
    expect(seen).toEqual([
      { operation: "display.power", input: { state: "off" } },
    ]);
    expect(remote.results).toEqual([
      { success: true, code: "fake_powered_off", message: "" },
    ]);
  });

  it("bounds identify to the range the Runtime accepts", async () => {
    const h = await setup(() => [
      command("identify_screen", "k1", { payload: { durationSeconds: 900 } }),
      command("identify_screen", "k2", { payload: { durationSeconds: 1 } }),
      command("identify_screen", "k3", { payload: {} }),
    ]);
    await h.runner.poll();
    expect(h.handlers.calls).toEqual([
      "identify:120",
      "identify:5",
      "identify:15",
    ]);
  });

  it("reports a command that cannot run now as a failure", async () => {
    const handlers = { ...controls(), skipItem: () => false };
    const h = await setup(
      () => [command("skip_current_item", "k1")],
      {},
      handlers,
    );
    await h.runner.poll();
    expect(h.remote.results[0]).toMatchObject({
      success: false,
      code: "renderer_not_ready",
    });
  });

  it("skips a command the server no longer accepts", async () => {
    const h = await setup(() => [command("sync_now", "k1")], { ack: 409 });
    await h.runner.poll();
    expect(h.handlers.calls).toEqual([]);
    expect(h.remote.results).toEqual([]);
  });

  it("scopes what it remembers to its Screen and bounds it", async () => {
    const h = await setup(() => []);
    for (let index = 0; index < REMEMBERED_COMMANDS + 20; index++)
      await h.store.put({
        key: `key-${index}`,
        commandId: `c${index}`,
        type: "sync_now",
        status: "done",
        result: commandResult(true, "synchronized"),
      });
    expect(await h.store.get("key-0")).toBeUndefined();
    expect(await h.store.get(`key-${REMEMBERED_COMMANDS + 19}`)).toBeDefined();
    const other = new CommandStore(h.database, "other-slot");
    expect(await other.get(`key-${REMEMBERED_COMMANDS + 19}`)).toBeUndefined();
  });
});
