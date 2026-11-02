import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeHost } from "./host";

const callbacks = () => ({
  ready: () => {},
  evidence: () => {},
  error: () => {},
  result: () => {},
  info: {
    host: "tilecast-player-web",
    hostVersion: "0.1.0",
    engine: "test",
    engineVersion: "0",
  },
});

describe("runtime host frame capability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("advertises external frames only under a controlling service worker", () => {
    vi.stubGlobal("navigator", { serviceWorker: { controller: {} } });
    const capabilities = runtimeHost(callbacks()).host.capabilities;
    expect(capabilities.externalFrames).toBe(true);
    // Response sandboxing rides the same gate: bare navigations reach
    // the worker, which serves the grant with the sandbox directive.
    expect(capabilities.externalFrameSandbox).toBe("response");
    vi.stubGlobal("navigator", { serviceWorker: {} });
    expect(runtimeHost(callbacks()).host.capabilities.externalFrames).toBe(
      false,
    );
    vi.stubGlobal("navigator", {});
    expect(runtimeHost(callbacks()).host.capabilities.externalFrames).toBe(
      false,
    );
  });

  it("reads the controller live on every access", () => {
    const serviceWorker: { controller?: object } = {};
    vi.stubGlobal("navigator", { serviceWorker });
    const host = runtimeHost(callbacks()).host;
    expect(host.capabilities.externalFrames).toBe(false);
    serviceWorker.controller = {};
    expect(host.capabilities.externalFrames).toBe(true);
  });
});
