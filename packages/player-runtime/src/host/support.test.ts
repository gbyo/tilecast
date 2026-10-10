import { describe, expect, it } from "vitest";
import { runtimeSupport } from "./support";
import { SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES } from "../compat/projection/presentation-capabilities.gen";

describe("Runtime readiness support", () => {
  it("uses live Widget discovery, including absent and changed components", () => {
    const discovered = { "widget.custom.counter": 3 };
    const support = runtimeSupport(discovered, false);
    expect(support.presentationSchemas).toEqual([1, 2, 3]);
    expect(support.widgetComponents).toEqual(discovered);
    expect(support.widgetComponents["widget.tilecast.clock"]).toBeUndefined();
    discovered["widget.custom.counter"] = 4;
    expect(support.widgetComponents["widget.custom.counter"]).toBe(3);
    expect(support.declarativeCapabilities).toEqual(
      SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES,
    );
  });

  it("reports remote web only when the running host provides its port", () => {
    expect(
      runtimeSupport({}, false).declarativeCapabilities["web.remote"],
    ).toBeUndefined();
    expect(runtimeSupport({}, true).declarativeCapabilities["web.remote"]).toBe(
      2,
    );
  });
});

describe("external frame execution", () => {
  it("reports the frame ABI only when the host serves frames", () => {
    expect(
      runtimeSupport({}, false).widgetComponents["widget.external-runtime"],
    ).toBeUndefined();
    expect(
      runtimeSupport({}, false, true).widgetComponents[
        "widget.external-runtime"
      ],
    ).toBe(2);
  });
});
