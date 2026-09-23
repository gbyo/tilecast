// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  FilterBar,
  MetricTile,
  resolveTimeRange,
  useUrlFilters,
  type FilterDefinition,
} from ".";

// Cases below repeat the same labels, so rendered trees must not accumulate.
afterEach(cleanup);

describe("MetricTile", () => {
  it("names the comparison period alongside a delta", () => {
    render(
      <MetricTile
        label="Playback failures"
        value={12}
        delta={{
          change: 3,
          comparisonLabel: "previous 24 hours",
          direction: "up-is-bad",
        }}
      />,
    );

    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText(/Up 3 from previous 24 hours/)).toBeTruthy();
  });

  it("tones a rise as bad when rising is bad, and as good when it is good", () => {
    const { container, rerender } = render(
      <MetricTile
        label="Failures"
        value={4}
        delta={{
          change: 2,
          comparisonLabel: "previous week",
          direction: "up-is-bad",
        }}
      />,
    );
    expect(container.querySelector(".metric-tile__delta--bad")).toBeTruthy();

    rerender(
      <MetricTile
        label="Screens reporting"
        value={40}
        delta={{
          change: 2,
          comparisonLabel: "previous week",
          direction: "up-is-good",
        }}
      />,
    );
    expect(container.querySelector(".metric-tile__delta--good")).toBeTruthy();
  });

  it("reports no movement without a success or danger tone", () => {
    const { container } = render(
      <MetricTile
        label="Takeover activations"
        value={0}
        delta={{
          change: 0,
          comparisonLabel: "previous 24 hours",
          direction: "up-is-bad",
        }}
      />,
    );

    expect(screen.getByText(/Unchanged from previous 24 hours/)).toBeTruthy();
    expect(container.querySelector(".metric-tile__delta--bad")).toBeNull();
  });

  it("links the whole tile to the records behind the number", () => {
    render(
      <MemoryRouter>
        <MetricTile label="Playback failures" value={12} to="/activity?x=1" />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: /Playback failures/ });
    expect(link.getAttribute("href")).toBe("/activity?x=1");
  });
});

const definitions: FilterDefinition[] = [
  {
    key: "search",
    kind: "search",
    label: "Search activity",
    placeholder: "Search…",
  },
  {
    key: "screen",
    kind: "select",
    label: "Screen",
    allLabel: "All screens",
    options: [{ value: "screen-1", label: "Lobby north" }],
  },
];

function FilterHarness() {
  const { values, set, clear } = useUrlFilters(definitions);
  const location = useLocation();
  return (
    <>
      <FilterBar
        definitions={definitions}
        values={values}
        onChange={set}
        onClear={clear}
      />
      <output>{location.search}</output>
    </>
  );
}

describe("FilterBar", () => {
  it("keeps filter state in the URL without disturbing other parameters", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/activity?tab=proof"]}>
        <Routes>
          <Route path="/activity" element={<FilterHarness />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("combobox", { name: "Screen" }));
    await user.click(screen.getByRole("option", { name: "Lobby north" }));

    const search = screen.getByRole("status").textContent;
    expect(search).toContain("tab=proof");
    expect(search).toContain("screen=screen-1");
  });

  it("shows an active select filter as a chip using its option label", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/activity?screen=screen-1"]}>
        <Routes>
          <Route path="/activity" element={<FilterHarness />} />
        </Routes>
      </MemoryRouter>,
    );

    const chip = screen.getByRole("button", {
      name: /Remove filter Screen: Lobby north/,
    });
    expect(chip.textContent).toContain("Lobby north");

    await user.click(chip);
    expect(
      screen.queryByRole("button", {
        name: /Remove filter Screen: Lobby north/,
      }),
    ).toBeNull();
  });

  it("does not chip the search field, which shows its own value", () => {
    render(
      <MemoryRouter initialEntries={["/activity?search=lobby"]}>
        <Routes>
          <Route path="/activity" element={<FilterHarness />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText("Active filters")).toBeNull();
  });
});

describe("resolveTimeRange", () => {
  const now = new Date("2026-07-26T12:00:00.000Z");

  it("derives an equally long preceding window for a preset", () => {
    const range = resolveTimeRange("24h", "", "", now);

    expect(range.from).toBe("2026-07-25T12:00:00.000Z");
    expect(range.to).toBe("2026-07-26T12:00:00.000Z");
    expect(range.previous?.from).toBe("2026-07-24T12:00:00.000Z");
    expect(range.previous?.to).toBe("2026-07-25T12:00:00.000Z");
    expect(range.previous?.label).toBe("previous 24 hours");
  });

  it("matches the comparison window to a complete custom range", () => {
    const range = resolveTimeRange(
      "custom",
      "2026-07-20T00:00",
      "2026-07-24T00:00",
      now,
    );

    const span = new Date(range.to).getTime() - new Date(range.from).getTime();
    const previousSpan =
      new Date(range.previous!.to).getTime() -
      new Date(range.previous!.from).getTime();
    expect(previousSpan).toBe(span);
    expect(range.previous!.to).toBe(range.from);
  });

  it("offers no comparison when a custom range is missing a bound", () => {
    const range = resolveTimeRange("custom", "2026-07-20T00:00", "", now);

    expect(range.previous).toBeUndefined();
  });

  it("falls back to a usable range when a bound cannot be parsed", () => {
    // Bounds come from the URL, so they can be anything.
    const range = resolveTimeRange("custom", "not-a-date", "also-bad", now);

    expect(() => new Date(range.from).toISOString()).not.toThrow();
    expect(range.to).toBe(now.toISOString());
    expect(range.previous).toBeUndefined();
  });

  it("orders reversed custom bounds rather than reporting a negative span", () => {
    const range = resolveTimeRange(
      "custom",
      "2026-07-24T00:00",
      "2026-07-20T00:00",
      now,
    );

    expect(new Date(range.from) < new Date(range.to)).toBe(true);
    expect(new Date(range.previous!.from) < new Date(range.previous!.to)).toBe(
      true,
    );
  });
});

describe("typed filters", () => {
  it("waits for a pause before writing to the URL, and commits on blur", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/activity"]}>
        <Routes>
          <Route path="/activity" element={<FilterHarness />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.type(screen.getByRole("searchbox"), "lob");
    // Still mid-typing: the URL has not been touched.
    expect(screen.getByRole("status").textContent).not.toContain("search=");

    await user.tab();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("search=lob"),
    );
  });
});
