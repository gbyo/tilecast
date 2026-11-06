// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { DataSourceDetail } from "../../api/types";
import { ManualDataSourceEditor } from "./manual";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const saved = {
  id: "ds-1",
  name: "Menu",
  description: "",
  provider: "manual",
  configuration: {
    columns: [{ key: "title", label: "Title", type: "text" }],
    rows: [{ id: "row-1", values: { title: "Lunch" } }],
    dateSelection: { mode: "none" },
  },
} as unknown as DataSourceDetail;

describe("manual Data Source column keys", () => {
  it("moves existing cell values when a column key is renamed", async () => {
    vi.spyOn(api, "settings").mockResolvedValue({
      values: {
        "organization.locale": "en-US",
        "organization.timezone": "UTC",
        "organization.time_format": "locale",
      },
    } as never);
    const update = vi
      .spyOn(api, "updateDataSource")
      .mockImplementation((id) => Promise.resolve({ ...saved, id } as never));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ManualDataSourceEditor
          dataSource={saved}
          csrf="csrf"
          onClose={() => undefined}
          onSaved={() => undefined}
        />
      </QueryClientProvider>,
    );
    const key = await waitFor(() => {
      const input = document.querySelector<HTMLInputElement>(
        "#manual-column-key-0",
      );
      expect(input).not.toBeNull();
      return input!;
    });
    fireEvent.change(key, { target: { value: "heading" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Data Source" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const configuration = update.mock.calls[0]?.[1].configuration as {
      columns: { key: string }[];
      rows: { values: Record<string, string> }[];
    };
    expect(configuration.columns.map((column) => column.key)).toEqual([
      "heading",
    ]);
    expect(configuration.rows[0]?.values).toEqual({ heading: "Lunch" });
  }, 15_000);
});

describe("Manual Table simple list mode", () => {
  function setup() {
    vi.spyOn(api, "settings").mockResolvedValue({
      values: {
        "organization.locale": "en-US",
        "organization.timezone": "UTC",
        "organization.time_format": "locale",
      },
    } as never);
    return new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  }

  it("pastes a multiline list into ordinary Manual Table rows", async () => {
    const create = vi
      .spyOn(api, "createDataSource")
      .mockResolvedValue(saved as never);
    render(
      <QueryClientProvider client={setup()}>
        <ManualDataSourceEditor
          csrf="csrf"
          onClose={() => undefined}
          onSaved={() => undefined}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(document.querySelector("#manual-name")!, {
      target: { value: "Announcements" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Simple list" }));
    fireEvent.change(screen.getByLabelText("Text entries"), {
      target: { value: "First\n\n  Second  \nThird\n" },
    });

    expect(screen.getByText("Entries: 3/200")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(document.querySelector("#manual-cell-0-title")).toHaveValue("First");
    expect(document.querySelector("#manual-cell-1-title")).toHaveValue("Second");
    expect(document.querySelector("#manual-cell-2-title")).toHaveValue("Third");
    fireEvent.click(screen.getByRole("button", { name: "Save Data Source" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const configuration = create.mock.calls[0]![0].configuration as {
      columns: { key: string; type: string }[];
      rows: { id: string; values: Record<string, string> }[];
    };
    expect(configuration.columns).toEqual([
      { key: "title", label: "Title", type: "text" },
    ]);
    expect(configuration.rows.map((row) => row.values.title)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(new Set(configuration.rows.map((row) => row.id)).size).toBe(3);
  });

  it("rejects oversized lists instead of silently dropping entries", () => {
    render(
      <QueryClientProvider client={setup()}>
        <ManualDataSourceEditor
          csrf="csrf"
          onClose={() => undefined}
          onSaved={() => undefined}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(document.querySelector("#manual-name")!, {
      target: { value: "Large list" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Simple list" }));
    const input = screen.getByLabelText("Text entries");
    fireEvent.change(input, {
      target: {
        value: Array.from({ length: 201 }, (_, i) => "Item " + i).join("\n"),
      },
    });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save Data Source" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Table" })).toBeDisabled();
    expect(
      screen.getByText("A list can contain at most 200 non-empty lines."),
    ).toBeVisible();

    fireEvent.change(input, { target: { value: "A".repeat(501) } });
    expect(
      screen.getByText("Each list entry must be at most 500 characters."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Data Source" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "Valid\nAgain" } });
    expect(screen.getByRole("button", { name: "Save Data Source" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Table" })).toBeEnabled();
  });

  it("preserves existing multi-column tables by disabling simple list mode", () => {
    const multiColumn = {
      ...saved,
      configuration: {
        ...saved.configuration,
        columns: [
          { key: "title", label: "Title", type: "text" },
          { key: "room", label: "Room", type: "text" },
        ],
        rows: [{ id: "row-1", values: { title: "Lunch", room: "101" } }],
      },
    } as DataSourceDetail;
    render(
      <QueryClientProvider client={setup()}>
        <ManualDataSourceEditor
          dataSource={multiColumn}
          csrf="csrf"
          onClose={() => undefined}
          onSaved={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: "Simple list" })).toBeDisabled();
    expect(document.querySelector("#manual-cell-0-room")).toHaveValue("101");
  });
});
