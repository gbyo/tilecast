// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { PackageStudioUI, parseStudioBridgeCall } from "./PackageStudioUI";

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

describe("PackageStudioUI", () => {
  afterEach(() => {
    cleanup();
    bridgeStub.mockClear();
  });

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

  it("relays frame calls over the bridge and answers the frame", async () => {
    await i18n.changeLanguage("en");
    render(<PackageStudioUI packageId="acme.kiosk" csrfToken="csrf" />);
    const frame = screen.getByTitle("Package interface");
    if (!(frame instanceof HTMLIFrameElement))
      throw new Error("expected an iframe");
    const target = frame.contentWindow;
    if (!target) throw new Error("iframe has no window");
    const posted: unknown[] = [];
    vi.spyOn(target, "postMessage").mockImplementation((message: unknown) => {
      posted.push(message);
    });

    const event = new MessageEvent("message", {
      data: { source: "tilecast-studio-ui", id: "call-1", input: "aGVsbG8=" },
    });
    Object.defineProperty(event, "source", { value: target });
    window.dispatchEvent(event);

    await waitFor(() => expect(bridgeStub).toHaveBeenCalledTimes(1));
    expect(bridgeStub).toHaveBeenCalledWith("acme.kiosk", "aGVsbG8=", "csrf");
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      source: "tilecast-studio-ui",
      id: "call-1",
      status: 3,
      output: "b2s=",
    });
  });

  it("ignores messages from other windows", async () => {
    await i18n.changeLanguage("en");
    render(<PackageStudioUI packageId="acme.kiosk" csrfToken="csrf" />);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "tilecast-studio-ui", id: "call-1", input: "aGVsbG8=" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridgeStub).not.toHaveBeenCalled();
  });

  it("answers transport failures with a bridge error", async () => {
    bridgeStub.mockRejectedValueOnce(new Error("forbidden"));
    await i18n.changeLanguage("en");
    render(<PackageStudioUI packageId="acme.kiosk" csrfToken="csrf" />);
    const frame = screen.getByTitle("Package interface");
    if (!(frame instanceof HTMLIFrameElement))
      throw new Error("expected an iframe");
    const target = frame.contentWindow;
    if (!target) throw new Error("iframe has no window");
    const posted: unknown[] = [];
    vi.spyOn(target, "postMessage").mockImplementation((message: unknown) => {
      posted.push(message);
    });

    const event = new MessageEvent("message", {
      data: { source: "tilecast-studio-ui", id: "call-9", input: "aGVsbG8=" },
    });
    Object.defineProperty(event, "source", { value: target });
    window.dispatchEvent(event);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      source: "tilecast-studio-ui",
      id: "call-9",
      status: -1,
      output: "",
      error: "bridge_failed",
    });
  });
});
