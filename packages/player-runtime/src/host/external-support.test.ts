import { expect, it } from "vitest";
import { runtimeSupport } from "./support";
it("advertises plugin execution only when the host separately qualifies it", () => {
  expect(
    runtimeSupport({}, false, true).declarativeCapabilities,
  ).not.toHaveProperty("plugin.external-runtime");
  expect(
    runtimeSupport({}, false, false, true).declarativeCapabilities[
      "plugin.external-runtime"
    ],
  ).toBe(1);
  expect(
    runtimeSupport({}, false, false, true).widgetComponents,
  ).not.toHaveProperty("widget.external-runtime");
});
