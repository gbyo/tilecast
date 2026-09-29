import { describe, expect, it } from "vitest";
import { LAYOUT_PREVIEW_CAPTURE_VERSION } from "../../content/widgetPreviewCapture";
import {
  LayoutCaptureCoordinator,
  layoutPreviewNeedsCapture,
} from "./layoutCaptureReadiness";

describe("LayoutCaptureCoordinator", () => {
  it("settles immediately when nothing is expected", async () => {
    const coordinator = new LayoutCaptureCoordinator();
    await expect(coordinator.waitForSettled([], 50)).resolves.toEqual({
      ok: true,
      failedIds: [],
    });
  });

  it("waits for registered zones to report ready or empty", async () => {
    const coordinator = new LayoutCaptureCoordinator();
    coordinator.register("zone-a");
    coordinator.register("zone-b");
    const waited = coordinator.waitForSettled(["zone-a", "zone-b"], 1000);
    coordinator.reportMountState("zone-a", "ready");
    coordinator.reportMountState("zone-b", "empty");
    await expect(waited).resolves.toEqual({ ok: true, failedIds: [] });
  });

  it("short-circuits on the first Widget error instead of blocking", async () => {
    const coordinator = new LayoutCaptureCoordinator();
    coordinator.register("zone-a");
    coordinator.register("zone-b");
    const waited = coordinator.waitForSettled(["zone-a", "zone-b"], 1000);
    coordinator.reportMountState("zone-a", "error");
    await expect(waited).resolves.toEqual({
      ok: false,
      failedIds: ["zone-a"],
    });
  });

  it("times out instead of blocking forever on a stuck zone", async () => {
    const coordinator = new LayoutCaptureCoordinator();
    coordinator.register("zone-a");
    coordinator.register("zone-b");
    coordinator.reportMountState("zone-a", "ready");
    await expect(
      coordinator.waitForSettled(["zone-a", "zone-b"], 30),
    ).resolves.toEqual({ ok: false, failedIds: ["zone-b"] });
  });

  it("treats an unmounted zone as settled", async () => {
    const coordinator = new LayoutCaptureCoordinator();
    coordinator.register("zone-a");
    coordinator.unregister("zone-a");
    await expect(coordinator.waitForSettled(["zone-a"], 50)).resolves.toEqual({
      ok: true,
      failedIds: [],
    });
  });

  it("waits for an expected zone that registers late", async () => {
    const coordinator = new LayoutCaptureCoordinator();
    const waited = coordinator.waitForSettled(["zone-a"], 1000);
    // Definitions and sources resolve after the Layout itself renders.
    await new Promise((resolve) => setTimeout(resolve, 20));
    coordinator.register("zone-a");
    coordinator.reportMountState("zone-a", "ready");
    await expect(waited).resolves.toEqual({ ok: true, failedIds: [] });
  });

  it("includes playlist zones showing a Widget when the wait starts", async () => {
    const coordinator = new LayoutCaptureCoordinator();
    coordinator.register("direct-zone");
    coordinator.register("playlist-zone");
    const waited = coordinator.waitForSettled(["direct-zone"], 1000);
    coordinator.reportMountState("direct-zone", "ready");
    coordinator.reportMountState("playlist-zone", "ready");
    await expect(waited).resolves.toEqual({ ok: true, failedIds: [] });
  });

  it("ignores reports for zones that never registered", () => {
    const coordinator = new LayoutCaptureCoordinator();
    coordinator.reportMountState("ghost", "ready");
    expect(coordinator.status("ghost")).toBeUndefined();
  });
});

describe("layoutPreviewNeedsCapture", () => {
  it("recaptures a missing preview", () => {
    expect(layoutPreviewNeedsCapture(undefined, undefined)).toBe(true);
    expect(layoutPreviewNeedsCapture("", 1)).toBe(true);
  });

  it("recaptures a preview from an older pipeline", () => {
    expect(
      layoutPreviewNeedsCapture("/api/v1/layouts/x/preview-image", undefined),
    ).toBe(true);
    expect(
      layoutPreviewNeedsCapture("/api/v1/layouts/x/preview-image", null),
    ).toBe(true);
    expect(
      layoutPreviewNeedsCapture("/api/v1/layouts/x/preview-image", 0),
    ).toBe(true);
  });

  it("trusts a preview from the current pipeline", () => {
    expect(
      layoutPreviewNeedsCapture(
        "/api/v1/layouts/x/preview-image",
        LAYOUT_PREVIEW_CAPTURE_VERSION,
      ),
    ).toBe(false);
  });
});
