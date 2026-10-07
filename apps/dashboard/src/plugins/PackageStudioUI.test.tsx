// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { PackageStudioUI } from "./PackageStudioUI";
import {
  clampStudioHeight,
  isStudioHello,
  parseStudioBridgeCall,
  parseStudioResize,
  studioFrameHeight,
} from "./studioBridge";

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

const resizeMessage = (height: unknown) => ({
  source: "tilecast-studio-ui",
  kind: "studio-resize",
  height,
});

describe("parseStudioResize", () => {
  it("accepts a finite positive height", () => {
    expect(parseStudioResize(resizeMessage(320))).toBe(320);
    expect(parseStudioResize(resizeMessage(412.6))).toBe(412.6);
  });

  it("ignores malformed or oversized reports", () => {
    for (const data of [
      null,
      "studio-resize",
      resizeMessage("320"),
      resizeMessage(null),
      resizeMessage(Number.NaN),
      resizeMessage(Number.POSITIVE_INFINITY),
      resizeMessage(0),
      resizeMessage(-40),
      resizeMessage(1_000_000),
      { ...resizeMessage(300), source: "other" },
      { ...resizeMessage(300), kind: "studio-hello" },
      { ...resizeMessage(300), extra: true },
      { source: "tilecast-studio-ui", kind: "studio-resize" },
    ]) {
      expect(parseStudioResize(data)).toBeNull();
    }
  });
});

describe("clampStudioHeight", () => {
  it("keeps the frame between its minimum and maximum", () => {
    expect(clampStudioHeight(10)).toBe(studioFrameHeight.min);
    expect(clampStudioHeight(412.4)).toBe(412);
    expect(clampStudioHeight(5_000)).toBe(studioFrameHeight.max);
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

  it("starts at a modest height rather than a tall empty frame", async () => {
    await i18n.changeLanguage("en");
    render(<PackageStudioUI packageId="acme.kiosk" csrfToken="csrf" />);
    expect(screen.getByTitle("Package interface")).toHaveStyle({
      height: `${studioFrameHeight.initial}px`,
    });
  });

  it("follows the height the frame reports over its port, clamped", async () => {
    await i18n.changeLanguage("en");
    render(<PackageStudioUI packageId="acme.kiosk" csrfToken="csrf" />);
    const { frame, target } = frameOf();
    const spy = vi.spyOn(target, "postMessage").mockImplementation(() => {});
    hello(target);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const framePort = transfersOf(spy)[0]?.transfer[0] as MessagePort;

    framePort.postMessage(resizeMessage(340));
    await waitFor(() => expect(frame).toHaveStyle({ height: "340px" }));
    framePort.postMessage(resizeMessage(40));
    await waitFor(() =>
      expect(frame).toHaveStyle({ height: `${studioFrameHeight.min}px` }),
    );
    framePort.postMessage(resizeMessage(9_000));
    await waitFor(() =>
      expect(frame).toHaveStyle({ height: `${studioFrameHeight.max}px` }),
    );
    // A resize is not a bridge call.
    expect(bridgeStub).not.toHaveBeenCalled();
  });

  it("ignores malformed resize reports and the window bus", async () => {
    await i18n.changeLanguage("en");
    render(<PackageStudioUI packageId="acme.kiosk" csrfToken="csrf" />);
    const { frame, target } = frameOf();
    const spy = vi.spyOn(target, "postMessage").mockImplementation(() => {});
    // A resize on the shared window bus never counts, hello or not.
    const forged = new MessageEvent("message", {
      origin: "null",
      data: resizeMessage(500),
    });
    Object.defineProperty(forged, "source", { value: target });
    window.dispatchEvent(forged);
    hello(target);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const framePort = transfersOf(spy)[0]?.transfer[0] as MessagePort;

    framePort.postMessage(resizeMessage("500"));
    framePort.postMessage(resizeMessage(Number.NaN));
    framePort.postMessage(resizeMessage(1_000_000));
    framePort.postMessage({ ...resizeMessage(500), extra: 1 });
    // A well-formed report afterwards proves the port is still live and
    // that none of the earlier ones moved the frame.
    framePort.postMessage(resizeMessage(300));
    await waitFor(() => expect(frame).toHaveStyle({ height: "300px" }));
  });

  it("does not animate height for people who prefer reduced motion", async () => {
    await i18n.changeLanguage("en");
    render(<PackageStudioUI packageId="acme.kiosk" csrfToken="csrf" />);
    const frame = screen.getByTitle("Package interface");
    expect(frame.className).toContain("transition-[height]");
    expect(frame.className).toContain("motion-reduce:transition-none");
  });
});
