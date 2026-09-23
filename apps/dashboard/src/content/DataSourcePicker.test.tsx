// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataSource, DataSourceDefinition } from "../api/types";
import { DataSourcePicker } from "./DataSourcePicker";

// The real Data Source editors are large provider-specific forms with their own network
// behavior. This suite is about the picker's contract with them: the editor is rendered in
// place, and whatever it saves becomes the picker's selection.
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      // The Connect flow reads the provider catalog, exactly as the Data Sources page does.
      contentDefinitions: () =>
        Promise.resolve({
          revision: "test",
          compilerVersion: "test",
          fingerprint: "test",
          widgets: [],
          dataSources: catalogDefinitions,
        }),
      previewSavedDataSource: () => Promise.resolve({}),
    },
  };
});

vi.mock("./data-sources/dispatcher", () => ({
  DataSourceEditor: ({
    provider,
    onSaved,
  }: {
    provider: string;
    onSaved: (value: { id: string }) => void;
  }) => (
    <div role="dialog" aria-label={`${provider} editor`}>
      <button type="button" onClick={() => onSaved({ id: "created-source" })}>
        Save {provider}
      </button>
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const csvDefinition: DataSourceDefinition = {
  id: "csv",
  version: 1,
  name: "CSV",
  description: "Upload a spreadsheet export.",
  category: "Data",
  icon: "spreadsheet",
  configurationSchema: { fields: [] },
  defaultConfiguration: {},
  outputSchema: { kind: "records", fields: [] },
  adapterId: "csv_adapter",
  refreshBehavior: "interval",
  // CSV ships as a legacy-editor provider, so its Studio copy comes from the provider
  // metadata rather than the definition's own setup block.
  legacyEditor: true,
};

const weatherDefinition: DataSourceDefinition = {
  ...csvDefinition,
  id: "weather",
  name: "Weather",
  description: "Cache a forecast.",
};

// Every suite renders against the same catalog; a test narrows what is offered through the
// picker's accepted-provider list, which is what a Widget does.
const catalogDefinitions = [csvDefinition, weatherDefinition];

const existing: DataSource = {
  id: "existing",
  provider: "csv",
  name: "Lunch rows",
  description: "",
  configVersion: 2,
  configuration: {},
  status: "ready",
  cachedRecordCount: 12,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function picker(sources: DataSource[]) {
  const onChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <div className="asset-details-drawer">
        <DataSourcePicker
          value=""
          sources={sources}
          csrf="csrf-token"
          onChange={onChange}
        />
      </div>
    </QueryClientProvider>,
  );
  return { ...result, onChange };
}

describe("DataSourcePicker", () => {
  it("selects a source created in place, without leaving the editor", async () => {
    const { onChange } = picker([]);

    await userEvent.click(
      screen.getByRole("button", { name: /Connect new data/ }),
    );
    // The in-editor path runs the same gallery the Data Sources page runs.
    const gallery = screen.getByRole("dialog", { name: "Create Data Source" });
    expect(within(gallery).getByRole("button", { name: /CSV/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /CSV/ }));
    // The chosen provider opens with the same setup guidance the page shows, not a bare
    // editor.
    expect(screen.getByText("Setup checklist")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Create CSV Data Source" }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save csv" }));

    expect(onChange).toHaveBeenCalledWith("created-source");
    // The flow closes on save and hands control back to the form it was opened from.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // As a modal it must take focus, keep Tab inside itself, and hand focus back when it
  // closes; otherwise the caret stays in the form underneath, on controls now covered.
  it("holds focus inside the Connect gallery and returns it on close", async () => {
    picker([]);

    const trigger = screen.getByRole("button", { name: /Connect new data/ });
    trigger.focus();
    await userEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Create Data Source" });
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );

    // Tab from the last control wraps to the first rather than escaping the dialog.
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>("button:not(:disabled)"),
    );
    focusable[focusable.length - 1]?.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(focusable[0]);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("chooses existing data from a modal with source context", async () => {
    const { onChange } = picker([existing]);

    await userEvent.click(
      screen.getByRole("button", { name: "Data Source: Choose data" }),
    );

    const dialog = screen.getByRole("dialog", { name: "Choose data" });
    expect(dialog).toBeTruthy();
    // Portaling prevents the drawer's descendant reset from stripping the modal surface.
    expect(dialog.closest(".asset-details-drawer")).toBeNull();
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(screen.getByText("CSV")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("12 records")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Lunch rows/ }));

    expect(onChange).toHaveBeenCalledWith("existing");
    expect(screen.queryByRole("dialog", { name: "Choose data" })).toBeNull();
  });

  it("keeps the chooser usable when an older list response omits refresh metadata", async () => {
    const legacySource = {
      ...existing,
      status: undefined,
      cachedRecordCount: undefined,
    } as unknown as DataSource;
    const { onChange } = picker([legacySource]);

    await userEvent.click(
      screen.getByRole("button", { name: "Data Source: Choose data" }),
    );

    expect(screen.getByText("Status unavailable")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Lunch rows/ }));
    expect(onChange).toHaveBeenCalledWith("existing");
  });

  it("offers connecting new data alongside existing sources", async () => {
    picker([existing]);

    await userEvent.click(
      screen.getByRole("button", { name: "Data Source: Choose data" }),
    );
    expect(
      screen.getByRole("button", { name: /Connect new data/ }),
    ).toBeTruthy();
  });

  it("omits the empty option when a binding must always reference a source", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <DataSourcePicker
          value="existing"
          sources={[existing]}
          csrf="csrf-token"
          allowEmpty={false}
          onChange={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Data Source: Lunch rows" }),
    );
    expect(screen.queryByRole("button", { name: /No data/ })).toBeNull();
  });

  it("reports the selected source's status and cached record count", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <DataSourcePicker
          value="existing"
          sources={[existing]}
          csrf="csrf-token"
          onChange={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("12 records")).toBeTruthy();
  });

  // The trigger must keep a stale reference visible rather than presenting the first compatible
  // source as though it were already selected.
  it("reports a referenced source that is no longer available", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <DataSourcePicker
          value="deleted-source"
          sources={[existing]}
          csrf="csrf-token"
          allowEmpty={false}
          onChange={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("button", {
        name: "Data Source: Unavailable Data Source",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("alert")).toHaveTextContent("no longer available");

    await userEvent.click(
      screen.getByRole("button", {
        name: "Data Source: Unavailable Data Source",
      }),
    );
    expect(screen.getByRole("button", { name: /Lunch rows/ })).toBeTruthy();
  });

  // With nothing compatible left, the empty state must not hide the fact that something is still
  // referenced.
  it("keeps the missing reference visible when no compatible source remains", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <DataSourcePicker
          value="deleted-source"
          sources={[]}
          csrf="csrf-token"
          onChange={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("No compatible data connected yet")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Data Source: Unavailable Data Source",
      }),
    );
    expect(
      screen.getByRole("button", { name: /Connect new data/ }),
    ).toBeTruthy();
  });

  it("offers only providers the consumer accepts when connecting new data", async () => {
    const onChange = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <DataSourcePicker
          value=""
          sources={[]}
          createProviders={["csv"]}
          csrf="csrf-token"
          onChange={onChange}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /Connect new data/ }),
    );

    expect(screen.getByRole("button", { name: /CSV/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Weather/ })).toBeNull();
  });

  it("shows an inferred format guide for legacy Widget provider lists", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <DataSourcePicker
          value=""
          sources={[]}
          createProviders={["csv", "json", "manual", "weather"]}
          csrf="csrf-token"
          onChange={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Data format")).toBeTruthy();
    expect(screen.getByText("Records with a numeric value")).toBeTruthy();
    expect(screen.getByText("Value")).toBeTruthy();
    expect(screen.getByText("number")).toBeTruthy();
  });

  it("does not offer creation to an author without write access", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <DataSourcePicker value="" sources={[]} onChange={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(screen.getByText("No compatible data connected yet")).toBeTruthy();
    expect(
      screen.getByText("Ask an editor to connect a compatible Data Source."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Connect new data/ }),
    ).toBeNull();
  });
});
