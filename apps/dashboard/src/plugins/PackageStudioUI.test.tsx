// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import {
  isStudioHello,
  PackageStudioUI,
  parseStudioBridgeCall,
} from "./PackageStudioUI";

vi.mock("../api/domains/fleet", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api/domains/fleet")>();
  return { ...mod, callStudioBridge: bridgeStub };
});

const bridgeStub = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ status: 3, output: "b2s=" })),
);

describe("parseStudioBridgeCall", () => {
  it("accepts a well-formed call", () => {
    expect(
      parseStudioBridgeCall({
        source: "tilecast-studio-ui",
        id: "call-1",
        input: "aGVsbG8=",
      }),
    ).toEqual({ id: "call-1", input: "aGVsbG8=" });
  });

  it("rejects foreign shapes", () => {
    const bad = [
      null,
      "tilecast-studio-ui",
      { source: "other", id: "a", input: "" },
      { source: "tilecast-studio-ui", id: "", input: "" },
      { source: "tilecast-studio-ui", id: "a" },
      {
        source: "tilecast-studio-ui",
        id: "a",
        input: "x".repeat(24 * 1024 + 1),
      },
    ];
    for (const data of bad) {
      expect(parseStudioBridgeCall(data)).toBeNull();
    }
  });
});

describe("isStudioHello", () => {
  it("accepts the frame announcement and nothing else", () => {
    expect(
      isStudioHello({ source: "tilecast-studio-ui", kind: "studio-hello" }),
    ).toBe(true);
    for (const data of [
      null,
      "studio-hello",
      { source: "tilecast-studio-ui" },
      { source: "other", kind: "studio-hello" },
      { source: "tilecast-studio-ui", kind: "studio-handshake" },
      { source: "tilecast-studio-ui", id: "call-1", input: "aGVsbG8=" },
    ]) {
      expect(isStudioHello(data)).toBe(false);
    }
  });
});

describe("PackageStudioUI", () => {
  afterEach(() => {
    cleanup();
    bridgeStub.mockClear();
  });

  function frameOf() {
    const frame = screen.getByTitle("Package interface");
    if (!(frame instanceof HTMLIFrameElement))
      throw new Error("expected an iframe");
    const target = frame.contentWindow;
    if (!target) throw new Error("iframe has no window");
    return { frame, target };
  }

  function hello(
    target: Window,
    overrides: { origin?: string; source?: unknown; data?: unknown } = {},
  ) {
    const event = new MessageEvent("message", {
      origin: overrides.origin ?? "null",
      data:
        "data" in overrides
          ? overrides.data
          : { source: "tilecast-studio-ui", kind: "studio-hello" },
    });
    Object.defineProperty(event, "source", {
      value: overrides.source ?? target,
    });
    window.dispatchEvent(event);
  }

  function transfersOf(spy: { mock: { calls: unknown[][] } }) {
    return spy.mock.calls.map((call) => ({
      message: call[0],
      origin: call[1],
      transfer: call[2] as unknown[],
    }));
  }

  it("hosts the frame sandboxed without credentials", async () => {
    await i18n.changeLanguage("en");
    render(<PackageStudioUI packageId="acme.kiosk" csrfToken="csrf" />);
    const frame = screen.getByTitle("Package interface");
    expect(frame).toHaveAttribute(
      "src",
      "/api/v1/packages/acme.kiosk/studio/frame",
    );
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  });

  it("hands the port to the frame hello, exactly once", async () => {
    await i18n.changeLanguage("en");
    render(<PackageStudioUI packageId="acme.kiosk" csrfToken="csrf" />);
    const { target } = frameOf();
    const spy = vi.spyOn(target, "postMessage").mockImplementation(() => {});
    // Mounting sends nothing: the hello drives the handshake.
    expect(spy).not.toHaveBeenCalled();
    hello(target);
    const transfers = transfersOf(spy);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.message).toEqual({
      source: "tilecast-studio-ui",
      kind: "studio-handshake",
    });
    expect(transfers[0]?.transfer).toHaveLength(1);
    expect(transfers[0]?.transfer[0]).toBeInstanceOf(MessagePort);
    hello(target);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ignores hellos from other windows, origins, or shapes", async () => {
    await i18n.changeLanguage("en");
    render(<PackageStudioUI packageId="acme.kiosk" csrfToken="csrf" />);
    const { target } = frameOf();
    const spy = vi.spyOn(target, "postMessage").mockImplementation(() => {});
    hello(target, { source: window });
    hello(target, { origin: "https://evil.example" });
    hello(target, { data: { source: "tilecast-studio-ui" } });
    hello(target, { data: null });
    // A call on the window bus is not a hello either.
    hello(target, {
      data: { source: "tilecast-studio-ui", id: "call-1", input: "aGVsbG8=" },
    });
    expect(spy).not.toHaveBeenCalled();
    expect(bridgeStub).not.toHaveBeenCalled();
    // None of the forgeries consumed the handshake.
    hello(target);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("relays port calls over the bridge and answers the frame", async () => {
    await i18n.changeLanguage("en");
    render(<PackageStudioUI packageId="acme.kiosk" csrfToken="csrf" />);
    const { target } = frameOf();
    const spy = vi.spyOn(target, "postMessage").mockImplementation(() => {});
    hello(target);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const framePort = transfersOf(spy)[0]?.transfer[0] as MessagePort;
    const answers: unknown[] = [];
    framePort.onmessage = (event: MessageEvent) =>
      void answers.push(event.data);
    framePort.postMessage({
      source: "tilecast-studio-ui",
      id: "call-1",
      input: "aGVsbG8=",
    });
    // Malformed port traffic never reaches the bridge.
    framePort.postMessage({ source: "tilecast-studio-ui", id: "call-2" });
    await waitFor(() => expect(bridgeStub).toHaveBeenCalledTimes(1));
    expect(bridgeStub).toHaveBeenCalledWith("acme.kiosk", "aGVsbG8=", "csrf");
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toEqual({
      source: "tilecast-studio-ui",
      id: "call-1",
      status: 3,
      output: "b2s=",
    });
    // Answers travel the port; the window bus stays silent after the
    // single-shot transfer.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("answers transport failures with a bridge error", async () => {
    bridgeStub.mockRejectedValueOnce(new Error("forbidden"));
    await i18n.changeLanguage("en");
    render(<PackageStudioUI packageId="acme.kiosk" csrfToken="csrf" />);
    const { target } = frameOf();
    const spy = vi.spyOn(target, "postMessage").mockImplementation(() => {});
    hello(target);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const framePort = transfersOf(spy)[0]?.transfer[0] as MessagePort;
    const answers: unknown[] = [];
    framePort.onmessage = (event: MessageEvent) =>
      void answers.push(event.data);
    framePort.postMessage({
      source: "tilecast-studio-ui",
      id: "call-9",
      input: "aGVsbG8=",
    });
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toEqual({
      source: "tilecast-studio-ui",
      id: "call-9",
      status: -1,
      output: "",
      error: "bridge_failed",
    });
  });

  it("dies on reload instead of binding the new document", async () => {
    await i18n.changeLanguage("en");
    render(<PackageStudioUI packageId="acme.kiosk" csrfToken="csrf" />);
    const { frame, target } = frameOf();
    const spy = vi.spyOn(target, "postMessage").mockImplementation(() => {});
    hello(target);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const framePort = transfersOf(spy)[0]?.transfer[0] as MessagePort;
    // The initial navigation's load is expected and changes nothing.
    frame.dispatchEvent(new Event("load"));
    expect(spy).toHaveBeenCalledTimes(1);
    // The reload kills the connection: no resend, no fresh channel for
    // the replacement document, and the interface reads unavailable.
    frame.dispatchEvent(new Event("load"));
    expect(
      await screen.findByText("The package interface could not be loaded."),
    ).toBeVisible();
    expect(spy).toHaveBeenCalledTimes(1);
    hello(target);
    expect(spy).toHaveBeenCalledTimes(1);
    framePort.postMessage({
      source: "tilecast-studio-ui",
      id: "call-1",
      input: "aGVsbG8=",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridgeStub).not.toHaveBeenCalled();
  });
});
