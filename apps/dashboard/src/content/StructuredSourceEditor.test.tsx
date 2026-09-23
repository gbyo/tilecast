// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { StructuredInspection } from "../api/types";
import { StructuredDataSourceEditor } from "./data-sources/structured";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const csvInspection: StructuredInspection = {
  provider: "csv",
  rowCount: 2,
  delimiter: ",",
  fields: [
    {
      key: "Event Name",
      label: "Event Name",
      samples: ["Board meeting"],
      type: "text",
    },
    { key: "Room", label: "Room", samples: ["204"], type: "text" },
    {
      key: "Start Date",
      label: "Start Date",
      samples: ["2026-09-01"],
      type: "date",
    },
  ],
  suggested: {
    rootList: "",
    title: "Event Name",
    subtitle: "Room",
    date: "Start Date",
    imageUrl: "",
    link: "",
  },
  available: {
    title: true,
    subtitle: true,
    date: true,
    author: false,
    description: false,
    image: true,
    link: true,
  },
};

function editor(provider: "csv" | "rss") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <StructuredDataSourceEditor
        provider={provider}
        csrf="csrf-token"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("StructuredDataSourceEditor", () => {
  it("detects CSV columns and maps them without the author typing a column name", async () => {
    const inspect = vi
      .spyOn(api, "inspectDataSource")
      .mockResolvedValue(csvInspection);
    editor("csv");

    await userEvent.click(screen.getByRole("button", { name: /Paste data/ }));
    await userEvent.click(screen.getByPlaceholderText(/title,subtitle,date/));
    await userEvent.paste(
      "Event Name,Room,Start Date\nBoard meeting,204,2026-09-01",
    );

    // Detection waits for the input to settle before it reads the connection.
    await waitFor(() => expect(inspect).toHaveBeenCalled(), { timeout: 3000 });
    await screen.findByText(/3 columns detected in 2 rows/, undefined, {
      timeout: 3000,
    });
    // The detected columns arrive as the mapping, so the author confirms rather than
    // recalls. Each control also shows a sample value from that column.
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Title" })).toHaveTextContent(
        "Event Name — Board meeting",
      ),
    );
    expect(
      screen.getByRole("combobox", { name: "Subtitle" }),
    ).toHaveTextContent("Room");
    expect(screen.getByRole("combobox", { name: "Date" })).toHaveTextContent(
      "Start Date",
    );
  });

  it("never asks a mapped Source about fields it cannot produce", () => {
    vi.spyOn(api, "inspectDataSource").mockResolvedValue(csvInspection);
    editor("csv");

    // Author and description belong to feeds. A CSV has no way to fill them, so the
    // displayed-field checkboxes are not part of this editor at all.
    expect(screen.queryByText("Displayed fields")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Author" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Description" })).toBeNull();
  });

  it("offers a feed only the fields that feed publishes", async () => {
    vi.spyOn(api, "inspectDataSource").mockResolvedValue({
      ...csvInspection,
      provider: "rss",
      delimiter: undefined,
      fields: [
        { key: "title", label: "Title", samples: ["Board news"], type: "text" },
      ],
      available: {
        title: true,
        subtitle: false,
        date: true,
        author: false,
        description: false,
        image: false,
        link: true,
      },
    });
    editor("rss");

    await userEvent.clear(screen.getByLabelText("Feed URL"));
    await userEvent.type(
      screen.getByLabelText("Feed URL"),
      "https://example.org/feed.xml",
    );

    await screen.findByText(/2 items read from this feed/, undefined, {
      timeout: 3000,
    });
    // The notice renders from the inspection response; the field checkboxes arrive
    // one effect tick later when the editor applies the detected availability.
    expect(
      await screen.findByRole("checkbox", { name: "Title" }, { timeout: 3000 }),
    ).toBeTruthy();
    // Author and description are on by default for a feed, but this feed carries neither,
    // so they are dropped rather than offered as dead controls.
    expect(screen.queryByRole("checkbox", { name: "Author" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Description" })).toBeNull();
  });

  // A schedule carries a start and an end, and the display slots hold one date between
  // them. Detection maps the rest as typed values, which is the only way a Widget that
  // asks for a datetime has anything to offer in its field picker.
  it("maps detected timestamps as typed values", async () => {
    vi.spyOn(api, "inspectDataSource").mockResolvedValue({
      ...csvInspection,
      rowCount: 6,
      fields: [
        { key: "title", label: "title", samples: ["Period 1"], type: "text" },
        {
          key: "startTime",
          label: "startTime",
          samples: ["2026-07-30T08:25:00-04:00"],
          type: "datetime",
        },
        {
          key: "endTime",
          label: "endTime",
          samples: ["2026-07-30T09:55:00-04:00"],
          type: "datetime",
        },
      ],
      suggested: {
        rootList: "",
        title: "title",
        subtitle: "",
        date: "startTime",
        imageUrl: "",
        link: "",
        valueFields: { startTime: "startTime", endTime: "endTime" },
        valueFieldTypes: { startTime: "datetime", endTime: "datetime" },
      },
    });
    editor("csv");

    await userEvent.click(screen.getByRole("button", { name: /Paste data/ }));
    await userEvent.click(screen.getByPlaceholderText(/title,subtitle,date/));
    await userEvent.paste(
      "title,startTime,endTime\nPeriod 1,2026-07-30T08:25:00-04:00,2026-07-30T09:55:00-04:00",
    );

    const startType = await screen.findByRole(
      "combobox",
      { name: "startTime type" },
      { timeout: 3000 },
    );
    expect(startType).toHaveTextContent("Date & time");
    expect(
      screen.getByRole("combobox", { name: "endTime type" }),
    ).toHaveTextContent("Date & time");

    // The author remains the authority: a detected type can be corrected.
    await userEvent.click(startType);
    await userEvent.click(screen.getByRole("option", { name: "Text" }));
    expect(startType).toHaveTextContent("Text");
    // Every timestamp is mapped, so there is nothing left to offer.
    expect(
      screen.queryByRole("button", { name: /detected time field/ }),
    ).toBeNull();
  });

  // A Source saved before this could type its times keeps its mapping, so the suggestion
  // never reaches it. Detection offers the fields it found as one deliberate action.
  it("offers detected timestamps to a Source that already has a mapping", async () => {
    vi.spyOn(api, "inspectDataSource").mockResolvedValue({
      ...csvInspection,
      fields: [
        ...csvInspection.fields,
        {
          key: "Start Time",
          label: "Start Time",
          samples: ["2026-09-01T08:25:00-04:00"],
          type: "datetime",
        },
      ],
    });
    editor("csv");

    await userEvent.click(screen.getByRole("button", { name: /Paste data/ }));
    await userEvent.click(screen.getByPlaceholderText(/title,subtitle,date/));
    await userEvent.paste(
      "Event Name,Room,Start Date,Start Time\nBoard meeting,204,2026-09-01,2026-09-01T08:25:00-04:00",
    );

    const add = await screen.findByRole(
      "button",
      { name: /Add 1 detected time field/ },
      { timeout: 3000 },
    );
    await userEvent.click(add);
    expect(
      screen.getByRole("combobox", { name: "Start Time type" }),
    ).toHaveTextContent("Date & time");
    // Offered once: the field is mapped now.
    expect(
      screen.queryByRole("button", { name: /detected time field/ }),
    ).toBeNull();
  });
});
