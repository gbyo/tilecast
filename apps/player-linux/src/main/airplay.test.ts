import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { AirplayManager, describeLimitation } from "./airplay";
import type { ExecutableResolution } from "../core/executable";
import type {
  ExternalPresentationConfig,
  ExternalPresentationStatus,
} from "../core/external-presentation";

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signalCode = signal;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }
}

function config(
  role: "single" | "gateway" | "receiver",
): ExternalPresentationConfig {
  return {
    provider: "airplay",
    sessionId: "8c3c4b1a-2f9b-4b5e-9ad1-3ca0b3ed0c77",
    receiverName: "HS Cafeteria",
    pin: "4821",
    deviceId: "02:11:22:33:44:55",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    role,
    targetType: role === "single" ? "screen" : "group",
    targetId: "d4c3b2a1-9876-4321-9abc-1234567890ab",
    gatewayScreenId: "d4c3b2a1-9876-4321-9abc-1234567890ab",
    audioScreenId: "d4c3b2a1-9876-4321-9abc-1234567890ab",
    transport: "unicast",
    videoPort: 42000,
    destinations:
      role === "single"
        ? []
        : [
            {
              screenId: "d4c3b2a1-9876-4321-9abc-1234567890ab",
              host: "127.0.0.1",
              port: 42000,
            },
          ],
    profile: "720p30",
    audioMode: "gateway_only",
  };
}

function resolvedExecutable(name: string): ExecutableResolution {
  return {
    name,
    status: "resolved",
    path: name === "uxplay" ? "/usr/local/bin/uxplay" : `/usr/bin/${name}`,
    candidates: [
      name === "uxplay" ? "/usr/local/bin/uxplay" : `/usr/bin/${name}`,
    ],
  };
}

interface TestManagerOptions {
  resolveExecutable?: (name: string) => Promise<ExecutableResolution>;
  onStatus?: (status: ExternalPresentationStatus | null) => void;
  /** Fail the nth (1-based) state-file write, to exercise a torn persist. */
  failWriteOnCall?: number;
  presentationNetwork?: FakePresentationNetwork;
}

const PRESENTATION_NETWORK_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const PRESENTATION_NETWORK_PSK = "test-only-presentation-psk-2026";

/**
 * Stands in for the root-owned Presentation Network manager. It records the
 * ordering of its calls relative to the media processes, which is where the
 * load-bearing guarantee lives: the network must be up before UxPlay can be seen
 * on the network at all.
 */
class FakePresentationNetwork {
  events: string[] = [];
  connectError: Error | null = null;
  assignment: {
    presentationNetworkId: string;
    name: string;
    configRevision: number;
  } | null = {
    presentationNetworkId: PRESENTATION_NETWORK_ID,
    name: "District Staff Wi-Fi",
    configRevision: 3,
  };
  status = {
    state: "provisioned" as string,
    networkName: "District Staff Wi-Fi",
    networkId: PRESENTATION_NETWORK_ID,
    activeNetworkId: null as string | null,
    installedNetworkId: PRESENTATION_NETWORK_ID as string | null,
    installedRevision: 3 as number | null,
    failureCode: undefined as string | undefined,
    failureMessage: undefined as string | undefined,
  };

  getAssignment() {
    return this.assignment;
  }

  getStatus() {
    return this.status;
  }

  async connect(reason: string) {
    this.events.push(`connect:${reason}`);
    if (this.connectError) {
      this.status = {
        ...this.status,
        state: "failed",
        failureCode: "authentication_failed",
        failureMessage: "Authentication to District Staff Wi-Fi failed.",
      };
      throw this.connectError;
    }
    this.status = {
      ...this.status,
      state: "connected",
      activeNetworkId: PRESENTATION_NETWORK_ID,
    };
    return this.status;
  }

  async disconnect(reason: string) {
    this.events.push(`disconnect:${reason}`);
    this.status = {
      ...this.status,
      state: "provisioned",
      activeNetworkId: null,
    };
  }

  async cleanupOrphaned() {
    this.events.push("cleanupOrphaned");
  }
}

function testManager(
  spawn: (binary: string, args: string[]) => FakeProcess,
  options: TestManagerOptions = {},
) {
  const files = new Map<string, unknown>();
  let writes = 0;
  const store = {
    writeJson: async (name: string, value: unknown) => {
      writes += 1;
      if (writes === options.failWriteOnCall) {
        throw new Error("state file is read-only");
      }
      files.set(name, value);
    },
    readJson: async <T>(name: string) =>
      (files.get(name) as T | undefined) ?? null,
    delete: async (name: string) => void files.delete(name),
  } as never;
  const calls: { binary: string; args: string[]; process: FakeProcess }[] = [];
  const timeline: string[] = [];
  if (options.presentationNetwork) {
    // Share one ordered timeline between the network calls and the process
    // spawns, so a test can assert that one happened before the other.
    const network = options.presentationNetwork;
    const originalConnect = network.connect.bind(network);
    network.connect = async (reason: string) => {
      timeline.push("presentation-network:connect");
      return originalConnect(reason);
    };
    const originalDisconnect = network.disconnect.bind(network);
    network.disconnect = async (reason: string) => {
      timeline.push("presentation-network:disconnect");
      return originalDisconnect(reason);
    };
  }
  const manager = new AirplayManager({
    store,
    resolveExecutable:
      options.resolveExecutable ?? (async (name) => resolvedExecutable(name)),
    onStatus: options.onStatus,
    presentationNetwork: options.presentationNetwork as never,
    spawn: ((binary: string, args: string[]) => {
      timeline.push(`spawn:${binary}`);
      const process = spawn(binary, args);
      calls.push({ binary, args, process });
      return process as never;
    }) as never,
  });
  return { manager, files, calls, timeline };
}

describe("AirPlay Linux process ownership", () => {
  it("uses UxPlay's direct fullscreen path for a single screen and cleans it up", async () => {
    const result = testManager(() => new FakeProcess());
    const session = config("single");
    await result.manager.prepareSession(session, "avdec_h264");
    await result.manager.startGateway("avdec_h264");

    expect(result.calls[0]?.binary).toBe("/usr/local/bin/uxplay");
    expect(result.calls[0]?.args).toContain("-pin");
    expect(result.calls[0]?.args).toContain("4821");
    expect(result.calls[0]?.args).toContain("-vd");
    expect(result.calls[0]?.args).not.toContain("-vrtp");
    expect(result.files.has("airplay-session.json")).toBe(true);

    await result.manager.stopSession("manual_stop");
    expect(result.files.has("airplay-session.json")).toBe(false);
    expect(result.calls[0]?.process.signalCode).toBe("SIGTERM");
  });

  it("keeps the gateway compressed in group mode and prepares a local receiver", async () => {
    const result = testManager(() => new FakeProcess());
    await result.manager.prepareSession(config("gateway"), "vah264dec");
    await result.manager.startGateway("vah264dec");

    expect(result.calls.map((call) => call.binary)).toEqual([
      "/usr/bin/gst-launch-1.0",
      "/usr/local/bin/uxplay",
    ]);
    const uxplayArgs = result.calls[1]?.args ?? [];
    expect(uxplayArgs).toContain("-vs");
    expect(uxplayArgs).toContain("0");
    expect(uxplayArgs).toContain("-vrtp");
    expect(
      uxplayArgs.some((arg) =>
        arg.includes("multiudpsink clients=127.0.0.1:42000"),
      ),
    ).toBe(true);
    expect(uxplayArgs).not.toContain("-vd");

    await result.manager.stopSession("group_stop");
    expect(
      result.calls.every((call) => call.process.signalCode === "SIGTERM"),
    ).toBe(true);
  });

  it("handles a receiver error and exit as one process failure", async () => {
    const result = testManager(() => new FakeProcess());
    await result.manager.prepareSession(config("gateway"), "vah264dec");
    const originalReceiver = result.calls[0]?.process;

    originalReceiver?.emit("error", new Error("receiver failed to start"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      result.calls.filter((call) => call.binary === "/usr/bin/gst-launch-1.0"),
    ).toHaveLength(2);

    // A child can emit both error and exit. The second notification belongs to
    // the same process and must not consume another bounded restart.
    originalReceiver?.emit("exit", 1, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      result.calls.filter((call) => call.binary === "/usr/bin/gst-launch-1.0"),
    ).toHaveLength(2);

    await result.manager.stopSession("test_cleanup");
  });

  it("enforces the local absolute expiry even without server contact", async () => {
    vi.useFakeTimers();
    try {
      const result = testManager(() => new FakeProcess());
      const session = config("single");
      session.expiresAt = new Date(Date.now() + 1_000).toISOString();
      await result.manager.prepareSession(session, "avdec_h264");
      await result.manager.startGateway("avdec_h264");

      await vi.advanceTimersByTimeAsync(1_100);

      expect(result.files.has("airplay-session.json")).toBe(false);
      expect(
        result.calls.every((call) => call.process.signalCode === "SIGTERM"),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AirPlay capability limitation reporting", () => {
  const ready = {
    uxplayInstalled: true,
    uxplayVersion: "1.73.6",
    gstreamerInstalled: true,
    decoder: "vah264dec" as const,
    avahiAvailable: true,
    hardware: true,
    hardwarePlugin: true,
    vainfoAvailable: true,
    supported: true,
  };

  it("names UxPlay when it is absent", () => {
    const limitation = describeLimitation({
      ...ready,
      uxplayInstalled: false,
      uxplayVersion: null,
      supported: false,
    });
    expect(limitation).toContain("UxPlay is not installed");
    expect(limitation).toContain("/install-airplay.sh");
  });

  // The common field failure: a distro package exists but predates the
  // baseline, so airplaySupported is false while uxplayInstalled is true.
  it("names the installed version when it is older than the baseline", () => {
    const limitation = describeLimitation({
      ...ready,
      uxplayVersion: "1.68",
      supported: false,
    });
    expect(limitation).toContain("1.68");
    expect(limitation).toContain("1.73.6");
  });

  it("names GStreamer and the decoder when they are missing", () => {
    expect(
      describeLimitation({
        ...ready,
        gstreamerInstalled: false,
        supported: false,
      }),
    ).toContain("GStreamer is not installed");
    expect(
      describeLimitation({
        ...ready,
        decoder: null,
        hardware: false,
        hardwarePlugin: false,
        supported: false,
      }),
    ).toContain("H.264 decoder");
  });

  it("explains an unusable VA-API driver with no software fallback", () => {
    const limitation = describeLimitation({
      ...ready,
      decoder: null,
      hardware: false,
      hardwarePlugin: true,
      supported: false,
    });
    expect(limitation).toContain("vainfo could not validate the driver");
    expect(limitation).toContain("avdec_h264");
  });

  // Blocking dependencies outrank quality notes: a box with neither UxPlay nor
  // VA-API must be told about UxPlay first, since that is what it fixes next.
  it("reports the blocking dependency ahead of a hardware-decode note", () => {
    expect(
      describeLimitation({
        ...ready,
        uxplayInstalled: false,
        uxplayVersion: null,
        decoder: "avdec_h264",
        hardware: false,
        hardwarePlugin: false,
        supported: false,
      }),
    ).toContain("UxPlay is not installed");
  });

  it("reports nothing for a fully provisioned player", () => {
    expect(describeLimitation(ready)).toBeUndefined();
  });

  it("does not call an existing but non-executable UxPlay missing", () => {
    const limitation = describeLimitation({
      ...ready,
      uxplayInstalled: true,
      uxplayFailure: "not_executable",
      uxplayPath: "/usr/local/bin/uxplay",
      supported: false,
    });
    expect(limitation).toContain("found at /usr/local/bin/uxplay");
    expect(limitation).toContain("not executable");
    expect(limitation).not.toContain("not installed");
  });
});

describe("AirPlay capability probing", () => {
  it("uses an absolute provisioned UxPlay path and its supported version flag", async () => {
    const result = testManager((binary) => {
      const process = new FakeProcess();
      queueMicrotask(() => {
        if (binary === "/usr/local/bin/uxplay") {
          process.stdout.emit(
            "data",
            'UxPlay version 1.73.6; for help, use option "-h"\n',
          );
        }
        process.exitCode = 0;
        process.emit("close", 0, null);
      });
      return process;
    });

    const capabilities = await result.manager.probeCapabilities();

    const uxplayCall = result.calls.find(
      (call) => call.binary === "/usr/local/bin/uxplay",
    );
    expect(uxplayCall?.args).toEqual(["-v"]);
    expect(capabilities.uxplayInstalled).toBe(true);
    expect(capabilities.uxplayVersion).toBe("1.73.6");
  });

  it("reports a resolved UxPlay whose version command fails as an execution failure", async () => {
    const result = testManager((binary) => {
      const process = new FakeProcess();
      queueMicrotask(() => {
        process.exitCode = binary === "/usr/local/bin/uxplay" ? 1 : 0;
        process.emit("close", process.exitCode, null);
      });
      return process;
    });

    const capabilities = await result.manager.probeCapabilities();

    expect(capabilities.uxplayInstalled).toBe(true);
    expect(capabilities.limitation).toContain(
      "UxPlay was found at /usr/local/bin/uxplay but its -v version check failed",
    );
  });
});

describe("AirPlay capability probing", () => {
  it("uses UxPlay's supported version flag and recognizes 1.73.6", async () => {
    const result = testManager((binary) => {
      const process = new FakeProcess();
      queueMicrotask(() => {
        if (binary === "/usr/local/bin/uxplay") {
          process.stdout.emit(
            "data",
            'UxPlay version 1.73.6; for help, use option "-h"\n',
          );
        }
        process.exitCode = 0;
        process.emit("close", 0, null);
      });
      return process;
    });

    const capabilities = await result.manager.probeCapabilities();

    expect(
      result.calls.find((call) => call.binary === "/usr/local/bin/uxplay")
        ?.args,
    ).toEqual(["-v"]);
    expect(capabilities.uxplayInstalled).toBe(true);
    expect(capabilities.uxplayVersion).toBe("1.73.6");
  });
});

describe("AirPlay persisted preparation state", () => {
  function persistedSession(files: Map<string, unknown>) {
    return files.get("airplay-session.json") as
      | {
          version: number;
          config: ExternalPresentationConfig;
          gatewayStarted: boolean;
        }
      | undefined;
  }

  it("records a group gateway as prepared, not started, and does not advertise", async () => {
    const result = testManager(() => new FakeProcess());
    await result.manager.prepareSession(config("gateway"), "vah264dec");

    const persisted = persistedSession(result.files);
    expect(persisted?.version).toBe(2);
    expect(persisted?.gatewayStarted).toBe(false);
    expect(persisted?.config.sessionId).toBe(config("gateway").sessionId);
    // The RTP receiver is up so the display is ready the moment the server
    // releases the room, but nothing is on the network yet.
    expect(result.calls.map((call) => call.binary)).toEqual([
      "/usr/bin/gst-launch-1.0",
    ]);

    await result.manager.stopSession("test_cleanup");
  });

  it("records the start permission before UxPlay can be seen on the network", async () => {
    const seenAtSpawn: (boolean | undefined)[] = [];
    const result = testManager((binary) => {
      if (binary === "/usr/local/bin/uxplay") {
        seenAtSpawn.push(
          (
            result.files.get("airplay-session.json") as
              { gatewayStarted: boolean } | undefined
          )?.gatewayStarted,
        );
      }
      return new FakeProcess();
    });
    await result.manager.prepareSession(config("gateway"), "vah264dec");
    await result.manager.startGateway("vah264dec");

    expect(seenAtSpawn).toEqual([true]);
    expect(persistedSession(result.files)?.gatewayStarted).toBe(true);

    await result.manager.stopSession("test_cleanup");
  });

  it("recovers a prepared gateway without advertising it", async () => {
    const result = testManager(() => new FakeProcess());
    result.files.set("airplay-session.json", {
      version: 2,
      config: config("gateway"),
      gatewayStarted: false,
    });

    const status = await result.manager.recoverSession("vah264dec");

    expect(status?.role).toBe("gateway");
    expect(status?.gatewayAlive).toBe(false);
    expect(result.calls.map((call) => call.binary)).toEqual([
      "/usr/bin/gst-launch-1.0",
    ]);
    expect(persistedSession(result.files)?.gatewayStarted).toBe(false);

    // The server's start command still releases it after the reboot.
    await result.manager.startGateway("vah264dec");
    expect(result.calls.map((call) => call.binary)).toEqual([
      "/usr/bin/gst-launch-1.0",
      "/usr/local/bin/uxplay",
    ]);
    expect(persistedSession(result.files)?.gatewayStarted).toBe(true);

    await result.manager.stopSession("test_cleanup");
  });

  it("recovers a started gateway with both processes", async () => {
    const result = testManager(() => new FakeProcess());
    result.files.set("airplay-session.json", {
      version: 2,
      config: config("gateway"),
      gatewayStarted: true,
    });

    const status = await result.manager.recoverSession("vah264dec");

    expect(status?.gatewayAlive).toBe(true);
    expect(result.calls.map((call) => call.binary)).toEqual([
      "/usr/bin/gst-launch-1.0",
      "/usr/local/bin/uxplay",
    ]);

    await result.manager.stopSession("test_cleanup");
  });

  it("recovers a single-screen session with UxPlay as before", async () => {
    const result = testManager(() => new FakeProcess());
    const single = config("single");
    await result.manager.prepareSession(single, "avdec_h264");
    await result.manager.startGateway("avdec_h264");
    const persisted = persistedSession(result.files);
    expect(persisted?.gatewayStarted).toBe(true);

    // Reboot: a fresh manager over the same on-disk state.
    const rebooted = testManager(() => new FakeProcess());
    rebooted.files.set("airplay-session.json", persisted);
    const status = await rebooted.manager.recoverSession("avdec_h264");

    expect(status?.role).toBe("single");
    expect(status?.gatewayAlive).toBe(true);
    expect(rebooted.calls.map((call) => call.binary)).toEqual([
      "/usr/local/bin/uxplay",
    ]);

    await result.manager.stopSession("test_cleanup");
    await rebooted.manager.stopSession("test_cleanup");
  });

  it("never advertises an old-format group gateway whose start state is unknown", async () => {
    const result = testManager(() => new FakeProcess());
    // Version 1 persisted the bare config with no record of the start phase.
    result.files.set("airplay-session.json", config("gateway"));

    const status = await result.manager.recoverSession("vah264dec");

    expect(status?.gatewayAlive).toBe(false);
    expect(result.calls.map((call) => call.binary)).toEqual([
      "/usr/bin/gst-launch-1.0",
    ]);
    // It is rewritten in the current format so the next reboot is unambiguous.
    expect(persistedSession(result.files)?.version).toBe(2);
    expect(persistedSession(result.files)?.gatewayStarted).toBe(false);

    await result.manager.stopSession("test_cleanup");
  });

  it("still recovers an old-format single-screen session, whose start state is knowable", async () => {
    const result = testManager(() => new FakeProcess());
    result.files.set("airplay-session.json", config("single"));

    const status = await result.manager.recoverSession("avdec_h264");

    expect(status?.gatewayAlive).toBe(true);
    expect(result.calls.map((call) => call.binary)).toEqual([
      "/usr/local/bin/uxplay",
    ]);

    await result.manager.stopSession("test_cleanup");
  });

  it("deletes an expired persisted session instead of recovering it", async () => {
    const result = testManager(() => new FakeProcess());
    const expired = config("gateway");
    expired.expiresAt = new Date(Date.now() - 1_000).toISOString();
    result.files.set("airplay-session.json", {
      version: 2,
      config: expired,
      gatewayStarted: true,
    });

    const status = await result.manager.recoverSession("vah264dec");

    expect(status).toBeNull();
    expect(result.files.has("airplay-session.json")).toBe(false);
    expect(result.calls).toHaveLength(0);
  });

  it("does not recover a corrupt persisted session or leave it behind", async () => {
    const result = testManager(() => new FakeProcess());
    result.files.set("airplay-session.json", { version: 2, config: {} });

    const status = await result.manager.recoverSession("vah264dec");

    expect(status).toBeNull();
    expect(result.files.has("airplay-session.json")).toBe(false);
    // An invalid configuration must not reach a process argument.
    expect(result.calls).toHaveLength(0);
  });

  it("discards a session written by a newer player instead of guessing", async () => {
    const result = testManager(() => new FakeProcess());
    // A downgrade could leave a format this build does not understand. Reading
    // it as a version 1 bare config would misinterpret every field.
    result.files.set("airplay-session.json", {
      version: 3,
      session: config("gateway"),
      advertising: true,
    });

    const status = await result.manager.recoverSession("vah264dec");

    expect(status).toBeNull();
    expect(result.files.has("airplay-session.json")).toBe(false);
    expect(result.calls).toHaveLength(0);
  });

  it("discards a legacy-shaped session with a string version", async () => {
    const result = testManager(() => new FakeProcess());
    result.files.set("airplay-session.json", {
      ...config("gateway"),
      version: "3",
    });

    const status = await result.manager.recoverSession("vah264dec");

    expect(status).toBeNull();
    expect(result.files.has("airplay-session.json")).toBe(false);
    expect(result.calls).toHaveLength(0);
  });

  it("rejects a persisted audio mode outside the v1 contract", async () => {
    const result = testManager(() => new FakeProcess());
    const legacy = {
      ...config("gateway"),
      audioMode: "all",
    } as unknown as ExternalPresentationConfig;
    result.files.set("airplay-session.json", legacy);

    const status = await result.manager.recoverSession("vah264dec");

    expect(status).toBeNull();
    expect(result.files.has("airplay-session.json")).toBe(false);
    expect(result.calls).toHaveLength(0);
  });

  it("does not advertise when the start permission cannot be persisted", async () => {
    // The prepare write succeeds; the write that records the server's start
    // permission fails. UxPlay must never start ahead of that record.
    const result = testManager(() => new FakeProcess(), {
      failWriteOnCall: 2,
    });
    await result.manager.prepareSession(config("gateway"), "vah264dec");
    expect(persistedSession(result.files)?.gatewayStarted).toBe(false);

    await expect(result.manager.startGateway("vah264dec")).rejects.toThrow(
      /read-only/,
    );

    expect(
      result.calls.some((call) => call.binary === "/usr/local/bin/uxplay"),
    ).toBe(false);
    // The failed start tears the session down rather than leaving a half-armed
    // gateway behind.
    expect(result.files.has("airplay-session.json")).toBe(false);
    expect(result.manager.getStatus()).toBeNull();
  });

  it("keeps the session while reconfiguring and clears it on stop", async () => {
    const statuses: (string | null)[] = [];
    const result = testManager(() => new FakeProcess(), {
      onStatus: (status) => statuses.push(status?.state ?? null),
    });

    const multicast = config("gateway");
    multicast.transport = "multicast";
    multicast.multicastAddress = "239.255.42.7";
    await result.manager.prepareSession(multicast, "vah264dec");
    await result.manager.startGateway("vah264dec");
    // Multicast -> unicast fallback reuses the same server session.
    await result.manager.prepareSession(config("gateway"), "vah264dec");

    expect(statuses).not.toContain(null);
    expect(persistedSession(result.files)?.config.transport).toBe("unicast");
    expect(persistedSession(result.files)?.gatewayStarted).toBe(false);

    await result.manager.stopSession("manual_stop");
    expect(result.files.has("airplay-session.json")).toBe(false);
    expect(statuses[statuses.length - 1]).toBeNull();
  });
});

describe("AirPlay with a Presentation Network", () => {
  function networkConfig(
    role: "single" | "gateway" | "receiver",
  ): ExternalPresentationConfig {
    return { ...config(role), presentationNetworkId: PRESENTATION_NETWORK_ID };
  }

  it("joins the network before UxPlay can advertise on a single screen", async () => {
    const network = new FakePresentationNetwork();
    const result = testManager(() => new FakeProcess(), {
      presentationNetwork: network,
    });
    await result.manager.prepareSession(networkConfig("single"), "avdec_h264");
    await result.manager.startGateway("avdec_h264");
    // The ordering is the contract. A receiver that appeared in a sender's picker
    // before the network it lives on was up would fail to connect.
    expect(result.timeline).toEqual([
      "presentation-network:connect",
      "spawn:/usr/local/bin/uxplay",
    ]);
  });

  it("joins the network before the gateway's own RTP receiver and UxPlay", async () => {
    const network = new FakePresentationNetwork();
    const result = testManager(() => new FakeProcess(), {
      presentationNetwork: network,
    });
    await result.manager.prepareSession(networkConfig("gateway"), "vah264dec");
    await result.manager.startGateway("vah264dec");
    expect(result.timeline).toEqual([
      "presentation-network:connect",
      "spawn:/usr/bin/gst-launch-1.0",
      "spawn:/usr/local/bin/uxplay",
    ]);
  });

  it("never starts UxPlay when the network cannot be joined", async () => {
    const network = new FakePresentationNetwork();
    network.connectError = new Error("Authentication failed.");
    const result = testManager(() => new FakeProcess(), {
      presentationNetwork: network,
    });
    await expect(
      result.manager.prepareSession(networkConfig("gateway"), "vah264dec"),
    ).rejects.toThrow(/Authentication/);
    // Nothing was spawned at all: no receiver, and above all no advertiser.
    expect(result.calls).toHaveLength(0);
    expect(result.files.has("airplay-session.json")).toBe(false);
  });

  it("reports joining progress and then connected in the session status", async () => {
    const statuses: (ExternalPresentationStatus | null)[] = [];
    const network = new FakePresentationNetwork();
    const result = testManager(() => new FakeProcess(), {
      presentationNetwork: network,
      onStatus: (status) => statuses.push(status),
    });
    await result.manager.prepareSession(networkConfig("gateway"), "vah264dec");
    const phases = statuses
      .filter((status): status is ExternalPresentationStatus => status !== null)
      .map((status) => status.presentationNetwork);
    expect(phases).toContain("joining");
    expect(phases).toContain("connected");
    // The display name reaches Studio; the SSID and credential never do.
    const named = statuses.find(
      (status) => status?.presentationNetworkName === "District Staff Wi-Fi",
    );
    expect(named).toBeTruthy();
  });

  it("leaves the network when the session stops, after the processes are gone", async () => {
    const network = new FakePresentationNetwork();
    const result = testManager(() => new FakeProcess(), {
      presentationNetwork: network,
    });
    await result.manager.prepareSession(networkConfig("gateway"), "vah264dec");
    await result.manager.startGateway("vah264dec");
    await result.manager.stopSession("manual_stop");
    expect(result.timeline.at(-1)).toBe("presentation-network:disconnect");
    expect(
      network.events.some((event) => event.startsWith("disconnect:")),
    ).toBe(true);
  });

  it("does not touch the network for a session that never used one", async () => {
    const network = new FakePresentationNetwork();
    const result = testManager(() => new FakeProcess(), {
      presentationNetwork: network,
    });
    // Exactly the existing Ethernet-only path: no assignment in the payload.
    await result.manager.prepareSession(config("gateway"), "vah264dec");
    await result.manager.startGateway("vah264dec");
    await result.manager.stopSession("manual_stop");
    expect(network.events).toEqual([]);
    expect(result.timeline).toEqual([
      "spawn:/usr/bin/gst-launch-1.0",
      "spawn:/usr/local/bin/uxplay",
    ]);
  });

  it("never asks a follower to join a network", async () => {
    const network = new FakePresentationNetwork();
    const result = testManager(() => new FakeProcess(), {
      presentationNetwork: network,
    });
    // A follower prepares only the GStreamer receiver path. It needs no Wi-Fi
    // adapter, no UxPlay advertisement, and no Presentation Network credential.
    await result.manager.prepareSession(config("receiver"), "vah264dec");
    expect(network.events).toEqual([]);
    expect(result.calls.map((call) => call.binary)).toEqual([
      "/usr/bin/gst-launch-1.0",
    ]);
  });

  it("refuses to prepare when the assigned configuration has not arrived yet", async () => {
    const network = new FakePresentationNetwork();
    network.assignment = null;
    const result = testManager(() => new FakeProcess(), {
      presentationNetwork: network,
    });
    await expect(
      result.manager.prepareSession(networkConfig("gateway"), "vah264dec"),
    ).rejects.toMatchObject({ code: "credential_unavailable" });
    expect(result.calls).toHaveLength(0);
  });

  it("refuses to prepare when the server names a network this player is not assigned", async () => {
    const network = new FakePresentationNetwork();
    network.assignment = {
      presentationNetworkId: "8f14e45f-ceea-467a-9575-6a1a0a1a0a1a",
      name: "Guest Wi-Fi",
      configRevision: 1,
    };
    const result = testManager(() => new FakeProcess(), {
      presentationNetwork: network,
    });
    await expect(
      result.manager.prepareSession(networkConfig("gateway"), "vah264dec"),
    ).rejects.toMatchObject({ code: "credential_unavailable" });
  });

  it("refuses to prepare on a build with no presentation-network support", async () => {
    const result = testManager(() => new FakeProcess());
    await expect(
      result.manager.prepareSession(networkConfig("gateway"), "vah264dec"),
    ).rejects.toMatchObject({ code: "helper_unavailable" });
  });

  it("reconnects the network before restoring UxPlay after a restart", async () => {
    const network = new FakePresentationNetwork();
    const first = testManager(() => new FakeProcess(), {
      presentationNetwork: network,
    });
    await first.manager.prepareSession(networkConfig("single"), "avdec_h264");
    await first.manager.startGateway("avdec_h264");
    const persisted = first.files.get("airplay-session.json");

    // A new process reads the persisted session. A previously started gateway must
    // restore its network *before* the receiver is advertised again.
    const recoveredNetwork = new FakePresentationNetwork();
    const second = testManager(() => new FakeProcess(), {
      presentationNetwork: recoveredNetwork,
    });
    second.files.set("airplay-session.json", persisted);
    await second.manager.recoverSession("avdec_h264");
    expect(second.timeline).toEqual([
      "presentation-network:connect",
      "spawn:/usr/local/bin/uxplay",
    ]);
  });

  it("does not reconnect the network for an expired session", async () => {
    const network = new FakePresentationNetwork();
    const result = testManager(() => new FakeProcess(), {
      presentationNetwork: network,
    });
    result.files.set("airplay-session.json", {
      version: 2,
      config: {
        ...networkConfig("single"),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      gatewayStarted: true,
    });
    expect(await result.manager.recoverSession("avdec_h264")).toBeNull();
    // Cleanup, not connect: an expired session must never rejoin Wi-Fi.
    expect(network.events).toEqual(["cleanupOrphaned"]);
    expect(result.calls).toHaveLength(0);
  });

  it("cleans up a connection a crash left behind when there is no session", async () => {
    const network = new FakePresentationNetwork();
    const result = testManager(() => new FakeProcess(), {
      presentationNetwork: network,
    });
    expect(await result.manager.recoverSession("avdec_h264")).toBeNull();
    expect(network.events).toEqual(["cleanupOrphaned"]);
  });

  it("never writes the credential into the persisted session file", async () => {
    const network = new FakePresentationNetwork();
    const result = testManager(() => new FakeProcess(), {
      presentationNetwork: network,
    });
    await result.manager.prepareSession(networkConfig("gateway"), "vah264dec");
    const persisted = JSON.stringify(result.files.get("airplay-session.json"));
    expect(persisted).toContain(PRESENTATION_NETWORK_ID);
    expect(persisted).not.toContain(PRESENTATION_NETWORK_PSK);
    expect(persisted).not.toContain("secret");
    expect(persisted).not.toContain("psk");
    expect(persisted).not.toContain("password");
    expect(persisted).not.toContain("District-Staff");
  });

  it("rejects a Presentation Network in a follower's payload", async () => {
    const { parseExternalPresentationConfig } =
      await import("../core/external-presentation");
    // The server never sends this to a receiver. Rejecting it here means a
    // malformed or tampered command cannot make a follower try to join Wi-Fi.
    expect(() =>
      parseExternalPresentationConfig({
        ...config("receiver"),
        presentationNetworkId: PRESENTATION_NETWORK_ID,
      }),
    ).toThrow(/receiver must not be given a Presentation Network/i);
  });
});
