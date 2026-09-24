import { describe, expect, it } from "vitest";
import { widgetContentArea } from "../components/layout-editor/WidgetLivePreview";

describe("Widget text sizing", () => {
  it("uses the center 80 percent of a Widget by default", () => {
    expect(widgetContentArea({ width: 1920, height: 1080 }, {})).toEqual({
      width: 1536,
      height: 864,
      horizontalPadding: 192,
      verticalPadding: 108,
    });
  });

  it("allows content to use the full Widget when padding is zero", () => {
    expect(
      widgetContentArea({ width: 960, height: 540 }, { contentPadding: 0 }),
    ).toEqual({
      width: 960,
      height: 540,
      horizontalPadding: 0,
      verticalPadding: 0,
    });
  });
});
