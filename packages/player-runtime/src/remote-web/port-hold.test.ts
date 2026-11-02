import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type {
  RemoteWebRenderTargetV1,
  RemoteWebSurfaceSpecV1,
} from "../host/contract";
import { RemoteWebPort } from "./port";

function host(target: RemoteWebRenderTargetV1) {
  const calls: string[] = [];
  return {
    calls,
    remoteWeb: {
      reportRecovered() {},
      async create(spec: RemoteWebSurfaceSpecV1) {
        calls.push(`create:${spec.surfaceId}:${spec.visible}`);
        return { ok: true as const, target };
      },
      updateViewport() {},
      setVisible(id: string, visible: boolean) {
        calls.push(`visible:${id}:${visible}`);
      },
      setMuted() {},
      reload() {},
      destroy(id: string) {
        calls.push(`destroy:${id}`);
      },
    },
  };
}

const spec = (visible: boolean) =>
  ({
    content: { kind: "website", url: "https://example.org/" },
    viewport: { x: 0, y: 0, width: 1920, height: 1080 },
    muted: true,
    visible,
  }) as unknown as Omit<RemoteWebSurfaceSpecV1, "surfaceId">;

describe("remote web startup hold", () => {
  it("keeps host-layer surfaces hidden while the startup layer covers the screen", async () => {
    const h = host({ kind: "host-layer" });
    const port = new RemoteWebPort(h.remoteWeb, new ManualClock({ wallMs: 0 }));
    port.holdHostLayers(true);
    const { state } = await port.create(spec(false), () => undefined);
    port.setVisible(state.surfaceId, true);
    expect(h.calls).toEqual(["create:rw-1:false", "visible:rw-1:false"]);
    port.holdHostLayers(false);
    expect(h.calls.at(-1)).toBe("visible:rw-1:true");
  });

  it("does not show a host-layer surface created visible during the hold", async () => {
    const h = host({ kind: "host-layer" });
    const port = new RemoteWebPort(h.remoteWeb, new ManualClock({ wallMs: 0 }));
    port.holdHostLayers(true);
    await port.create(spec(true), () => undefined);
    expect(h.calls).toEqual(["create:rw-1:false"]);
    port.holdHostLayers(false);
    expect(h.calls).toEqual(["create:rw-1:false", "visible:rw-1:true"]);
  });

  it("never holds media-uri surfaces, which the startup layer already covers", async () => {
    const h = host({ kind: "media-uri", uri: "tcweb://cap/abc" });
    const port = new RemoteWebPort(h.remoteWeb, new ManualClock({ wallMs: 0 }));
    port.holdHostLayers(true);
    const { state } = await port.create(spec(true), () => undefined);
    port.setVisible(state.surfaceId, true);
    expect(h.calls).toEqual([
      "create:rw-1:false",
      "visible:rw-1:true",
      "visible:rw-1:true",
    ]);
    port.holdHostLayers(false);
    expect(h.calls.length).toBe(3);
  });

  it("does not show a surface hidden or released during the hold", async () => {
    const h = host({ kind: "host-layer" });
    const port = new RemoteWebPort(h.remoteWeb, new ManualClock({ wallMs: 0 }));
    port.holdHostLayers(true);
    const a = await port.create(spec(true), () => undefined);
    const b = await port.create(spec(true), () => undefined);
    port.setVisible(a.state.surfaceId, false);
    port.release(b.state.surfaceId, null);
    const before = h.calls.length;
    port.holdHostLayers(false);
    expect(h.calls.slice(before)).toEqual([]);
  });

  it("passes visibility straight through without a hold", async () => {
    const h = host({ kind: "host-layer" });
    const port = new RemoteWebPort(h.remoteWeb, new ManualClock({ wallMs: 0 }));
    const { state } = await port.create(spec(true), () => undefined);
    port.setVisible(state.surfaceId, false);
    expect(h.calls).toEqual(["create:rw-1:true", "visible:rw-1:false"]);
  });

  it("applies a hold started while a host surface is being created", async () => {
    const h = host({ kind: "host-layer" });
    const create = h.remoteWeb.create;
    let ready!: () => void;
    h.remoteWeb.create = async (request) => {
      await new Promise<void>((resolve) => (ready = resolve));
      return create(request);
    };
    const port = new RemoteWebPort(h.remoteWeb, new ManualClock({ wallMs: 0 }));
    const pending = port.create(spec(true), () => undefined);
    port.holdHostLayers(true);
    ready();
    await pending;
    expect(h.calls.at(-1)).toBe("visible:rw-1:false");
    port.holdHostLayers(false);
    expect(h.calls.at(-1)).toBe("visible:rw-1:true");
  });

  it("keeps visibility requests hidden until the render target is known", async () => {
    const h = host({ kind: "host-layer" });
    const create = h.remoteWeb.create;
    let ready!: () => void;
    h.remoteWeb.create = async (request) => {
      await new Promise<void>((resolve) => (ready = resolve));
      return create(request);
    };
    const port = new RemoteWebPort(h.remoteWeb, new ManualClock({ wallMs: 0 }));
    port.holdHostLayers(true);
    const pending = port.create(spec(false), () => undefined);
    port.setVisible("rw-1", true);
    expect(h.calls).toEqual(["visible:rw-1:false"]);
    ready();
    await pending;
    port.holdHostLayers(false);
    expect(h.calls.at(-1)).toBe("visible:rw-1:true");
  });
});
