// @vitest-environment jsdom
// Automatic Data Source mapping runs only after the author connects a
// different source. Opening a saved Widget never maps anything and never
// makes the Widget look edited.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import type { ContentDefinitionField, DataSourceDetail } from "@/api/types";
import type { WidgetConfiguration } from "../widgetEditorModel";
import { useAutomaticFieldMapping } from "./useAutomaticFieldMapping";

afterEach(() => vi.restoreAllMocks());

const text = (key: string, role?: string) => ({
  key,
  label: key,
  type: "text",
  ...(role ? { role } : {}),
});

const sources: Record<string, ReturnType<typeof text>[]> = {
  "s-a": [text("dish", "title"), text("notes", "summary")],
  "s-b": [text("name", "title"), text("blurb", "summary")],
  // Shares "notes" with s-a, but has no "dish".
  "s-c": [text("heading", "title"), text("notes")],
};

const slot = (key: string, role: string): ContentDefinitionField => ({
  key,
  label: key,
  control: "data_source_field",
  dataSourceFieldTypes: ["text"],
  ui: { semanticRole: role },
});

const rootFields: ContentDefinitionField[] = [
  { key: "dataSourceId", label: "Data", control: "data_source" },
  slot("titleField", "title"),
  slot("summaryField", "summary"),
];

function harness(
  fields: ContentDefinitionField[],
  initial: WidgetConfiguration,
  readOnly = false,
) {
  const getDataSource = vi
    .spyOn(api, "getDataSource")
    .mockImplementation((id: string) =>
      Promise.resolve({
        id,
        provider: "test",
        name: id,
        fields: sources[id] ?? [],
      } as unknown as DataSourceDetail),
    );
  const updates = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () => {
      const [configuration, setConfiguration] = useState(initial);
      useAutomaticFieldMapping({
        fields,
        configuration,
        readOnly,
        updateConfiguration: (update) => {
          updates();
          setConfiguration(update);
        },
      });
      return { configuration, setConfiguration };
    },
    { wrapper },
  );
  /** The author changes a value, as the inspector does. */
  const edit = (
    change: (current: WidgetConfiguration) => WidgetConfiguration,
  ) => act(() => view.result.current.setConfiguration(change));
  /** Let the source details of the initial configuration arrive. */
  const settle = async (calls: number) => {
    await waitFor(() => expect(getDataSource).toHaveBeenCalledTimes(calls));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  };
  return { view, edit, settle, updates, getDataSource };
}

describe("opening a saved Widget", () => {
  it("changes nothing, however unmapped or stale its mapping is", async () => {
    const saved = {
      dataSourceId: "s-a",
      titleField: "",
      summaryField: "was-deleted",
    };
    const { view, settle, updates } = harness(rootFields, saved);
    await settle(1);
    expect(updates).not.toHaveBeenCalled();
    // The very same object: nothing was rewritten, so nothing can be dirty.
    expect(view.result.current.configuration).toBe(saved);
  });

  it("does not map a Widget that opens with no source", async () => {
    const saved = { dataSourceId: "", titleField: "", summaryField: "" };
    const { view, updates } = harness(rootFields, saved);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(updates).not.toHaveBeenCalled();
    expect(view.result.current.configuration).toBe(saved);
  });

  it("never maps in a read-only session, even after a change", async () => {
    const { view, edit, settle, updates } = harness(
      rootFields,
      { dataSourceId: "s-a", titleField: "dish", summaryField: "notes" },
      true,
    );
    await settle(1);
    edit((current) => ({ ...current, dataSourceId: "s-b" }));
    await settle(2);
    expect(updates).not.toHaveBeenCalled();
    expect(view.result.current.configuration.titleField).toBe("dish");
  });
});

describe("connecting a different source", () => {
  it("maps every slot from its role, exactly once", async () => {
    const { view, edit, settle, updates } = harness(rootFields, {
      dataSourceId: "s-a",
      titleField: "dish",
      summaryField: "notes",
    });
    await settle(1);
    edit((current) => ({ ...current, dataSourceId: "s-b" }));
    await waitFor(() =>
      expect(view.result.current.configuration).toMatchObject({
        titleField: "name",
        summaryField: "blurb",
      }),
    );
    // The author's own edit is not remapped afterwards.
    expect(updates).toHaveBeenCalledTimes(1);
    edit((current) => ({ ...current, titleField: "blurb" }));
    await settle(2);
    expect(view.result.current.configuration.titleField).toBe("blurb");
    expect(updates).toHaveBeenCalledTimes(1);
  });

  it("remaps a mapping the new source lacks and keeps one it still has", async () => {
    const { view, edit, settle } = harness(rootFields, {
      dataSourceId: "s-a",
      titleField: "dish", // gone in s-c: stale
      summaryField: "notes", // present in s-c: a valid choice that stands
    });
    await settle(1);
    edit((current) => ({ ...current, dataSourceId: "s-c" }));
    await waitFor(() =>
      expect(view.result.current.configuration.titleField).toBe("heading"),
    );
    expect(view.result.current.configuration.summaryField).toBe("notes");
  });

  it("clears a stale slot when nothing in the new source fits", async () => {
    const { view, edit, settle } = harness(
      [
        { key: "dataSourceId", label: "Data", control: "data_source" },
        {
          ...slot("amountField", "amount"),
          dataSourceFieldTypes: ["number"],
        },
      ],
      { dataSourceId: "s-a", amountField: "gone" },
    );
    await settle(1);
    edit((current) => ({ ...current, dataSourceId: "s-b" }));
    await waitFor(() =>
      expect(view.result.current.configuration.amountField).toBe(""),
    );
  });

  it("maps again when the author returns to an earlier source", async () => {
    const { view, edit, settle } = harness(rootFields, {
      dataSourceId: "s-a",
      titleField: "dish",
      summaryField: "notes",
    });
    await settle(1);
    edit((current) => ({ ...current, dataSourceId: "s-b" }));
    await waitFor(() =>
      expect(view.result.current.configuration.titleField).toBe("name"),
    );
    edit((current) => ({ ...current, dataSourceId: "s-a" }));
    await waitFor(() =>
      expect(view.result.current.configuration.titleField).toBe("dish"),
    );
    expect(view.result.current.configuration.summaryField).toBe("notes");
  });

  it("maps a source connected to a Widget that had none", async () => {
    const { view, edit, settle } = harness(rootFields, {
      dataSourceId: "",
      titleField: "",
      summaryField: "",
    });
    edit((current) => ({ ...current, dataSourceId: "s-a" }));
    await settle(1);
    await waitFor(() =>
      expect(view.result.current.configuration).toMatchObject({
        titleField: "dish",
        summaryField: "notes",
      }),
    );
  });
});

describe("repeating groups", () => {
  const groupFields: ContentDefinitionField[] = [
    {
      key: "panels",
      label: "Panels",
      control: "repeating_group",
      itemFields: [
        { key: "dataSourceId", label: "Data", control: "data_source" },
        slot("titleField", "title"),
      ],
    },
  ];
  const panel = (dataSourceId: string, titleField: string) => ({
    dataSourceId,
    titleField,
  });

  it("maps nothing when a saved group opens", async () => {
    const saved = { panels: [panel("s-a", ""), panel("s-b", "gone")] };
    const { view, settle, updates } = harness(groupFields, saved);
    await settle(2);
    expect(updates).not.toHaveBeenCalled();
    expect(view.result.current.configuration).toBe(saved);
  });

  it("maps only the row whose source changed", async () => {
    const { view, edit, settle } = harness(groupFields, {
      panels: [panel("s-a", "dish"), panel("s-a", "dish")],
    });
    await settle(1);
    edit((current) => ({
      panels: [
        (current.panels as WidgetConfiguration[])[0]!,
        {
          ...(current.panels as WidgetConfiguration[])[1]!,
          dataSourceId: "s-b",
        },
      ],
    }));
    await waitFor(() =>
      expect(
        (view.result.current.configuration.panels as WidgetConfiguration[])[1],
      ).toEqual(panel("s-b", "name")),
    );
    expect(
      (view.result.current.configuration.panels as WidgetConfiguration[])[0],
    ).toEqual(panel("s-a", "dish"));
  });

  it("maps rows that read the Widget's one root source", async () => {
    const shared: ContentDefinitionField[] = [
      { key: "dataSourceId", label: "Data", control: "data_source" },
      {
        key: "rows",
        label: "Rows",
        control: "repeating_group",
        itemFields: [
          slot("titleField", "title"),
          { key: "note", label: "Note", control: "text" },
        ],
      },
    ];
    const { view, edit, settle } = harness(shared, {
      dataSourceId: "s-a",
      rows: [
        { titleField: "dish", note: "keep me" },
        { titleField: "dish", note: "and me" },
      ],
    });
    await settle(1);
    edit((current) => ({ ...current, dataSourceId: "s-b" }));
    await waitFor(() =>
      expect(view.result.current.configuration.rows).toEqual([
        { titleField: "name", note: "keep me" },
        { titleField: "name", note: "and me" },
      ]),
    );
  });

  it("maps a source nested inside a group within a group", async () => {
    const nested: ContentDefinitionField[] = [
      {
        key: "sections",
        label: "Sections",
        control: "repeating_group",
        itemFields: [
          {
            key: "cards",
            label: "Cards",
            control: "repeating_group",
            itemFields: [
              { key: "dataSourceId", label: "Data", control: "data_source" },
              slot("titleField", "title"),
            ],
          },
        ],
      },
    ];
    const { view, edit, settle } = harness(nested, {
      sections: [
        { cards: [{ dataSourceId: "s-a", titleField: "dish" }] },
        { cards: [{ dataSourceId: "s-a", titleField: "dish" }] },
      ],
    });
    await settle(1);
    edit((current) => {
      const sections = current.sections as WidgetConfiguration[];
      const cards = sections[1]!.cards as WidgetConfiguration[];
      return {
        sections: [
          sections[0]!,
          { cards: [{ ...cards[0]!, dataSourceId: "s-b" }] },
        ],
      };
    });
    await waitFor(() =>
      expect(view.result.current.configuration.sections).toEqual([
        { cards: [{ dataSourceId: "s-a", titleField: "dish" }] },
        { cards: [{ dataSourceId: "s-b", titleField: "name" }] },
      ]),
    );
  });
});
