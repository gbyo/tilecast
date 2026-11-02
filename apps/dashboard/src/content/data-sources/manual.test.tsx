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
