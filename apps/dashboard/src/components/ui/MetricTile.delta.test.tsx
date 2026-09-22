// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricTile } from "./MetricTile";

afterEach(cleanup);

describe("MetricTile delta formatting", () => {
  it("passes the absolute change to custom formatters", () => {
    const format = vi.fn((change: number) => `${change / 3_600_000}h`);

    render(
      <MetricTile
        label="Confirmed screen playback"
        value="4h"
        delta={{
          change: -3_600_000,
          comparisonLabel: "previous 24 hours",
          direction: "up-is-good",
          format,
        }}
      />,
    );

    expect(format).toHaveBeenCalledWith(3_600_000);
    expect(
      screen.getByText("Down 1h from previous 24 hours"),
    ).toBeTruthy();
  });
});
