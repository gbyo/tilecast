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
import { api } from "../api/client";
import type {
  ContentDefinitionCatalog,
  ContentDefinitionField,
  DataSource,
  DataSourceDefinition,
  DataSourceDetail,
} from "../api/types";
import {
  DefinitionForm,
  dataFormatGuideFor,
  dataSourceKeysIn,
  resolveDataSourceKey,
} from "./DefinitionForm";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function definition(
  id: string,
  fields: { key: string; label: string; type: string }[],
): DataSourceDefinition {
  return {
    id,
    version: 1,
    name: `${id} source`,
    description: `Connect ${id} data.`,
    category: "Data",
    icon: "table",
    configurationSchema: { fields: [] },
    defaultConfiguration: {},
    outputSchema: { kind: "records", fields },
    adapterId: `${id}_adapter`,
    refreshBehavior: "interval",
  };
}

function source(id: string, provider: string, name: string): DataSource {
  return {
    id,
    provider,
    name,
    description: "",
    configVersion: 2,
    configuration: {},
    status: "ready",
    cachedRecordCount: 3,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function detail(id: string, fields: DataSourceDetail["fields"]) {
  return {
    ...source(id, "csv", id),
    diagnostics: {} as DataSourceDetail["diagnostics"],
    fields,
    widgetUsage: [],
    bindingUsage: [],
  } as DataSourceDetail;
}

function catalog(dataSources: DataSourceDefinition[]) {
  return {
    revision: "1",
    compilerVersion: "1",
    fingerprint: "abc",
    widgets: [],
    dataSources,
  } as ContentDefinitionCatalog;
}

// Field pickers use the Rhea Select primitive: a combobox trigger with popup
// options and no native select element, so option text is read by opening the
// dropdown. The Data Source control is a chooser dialog and is driven directly.
async function optionsFor(labelText: string | RegExp) {
  const trigger = screen.getByRole("combobox", { name: labelText });
  await userEvent.click(trigger);
  const options = await screen.findAllByRole("option");
  const texts = options.map((option) => option.textContent);
  await userEvent.keyboard("{Escape}");
  return texts;
}

function form(
  fields: ContentDefinitionField[],
  value: Record<string, unknown> = {},
) {
  const onChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <DefinitionForm
        fields={fields}
        value={value}
        onChange={onChange}
        csrf="csrf-token"
      />
    </QueryClientProvider>,
  );
  return { ...result, onChange };
}

describe("dataSourceKeysIn", () => {
  it("collects every Data Source a configuration references", () => {
    expect(
      dataSourceKeysIn(
        [
          { key: "primarySource", label: "Primary", control: "data_source" },
          { key: "compareSource", label: "Compare", control: "data_source" },
        ],
        { primarySource: "a", compareSource: "b" },
      ),
    ).toEqual(["a", "b"]);
  });

  // itemFields is recursive, so a Data Source inside a repeating group must still be found; missing
  // it would let the Widget editor save while that source's data was still loading.
  it("finds Data Sources nested inside a repeating group", () => {
    expect(
      dataSourceKeysIn(
        [
          { key: "primarySource", label: "Primary", control: "data_source" },
          {
            key: "rows",
            label: "Rows",
            control: "repeating_group",
            maximumItems: 4,
            itemFields: [
              { key: "rowSource", label: "Row data", control: "data_source" },
            ],
          },
        ],
        {
          primarySource: "a",
          rows: [{ rowSource: "b" }, { rowSource: "c" }, {}],
        },
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("reports each source once even when several fields share it", () => {
    expect(
      dataSourceKeysIn(
        [
          { key: "one", label: "One", control: "data_source" },
          { key: "two", label: "Two", control: "data_source" },
        ],
        { one: "same", two: "same" },
      ),
    ).toEqual(["same"]);
  });
});

describe("resolveDataSourceKey", () => {
  const sourceField: ContentDefinitionField = {
    key: "primarySource",
    label: "Primary",
    control: "data_source",
  };
  const secondSource: ContentDefinitionField = {
    key: "compareSource",
    label: "Compare",
    control: "data_source",
  };

  it("uses the single Data Source control when a definition declares one", () => {
    const field: ContentDefinitionField = {
      key: "valueField",
      label: "Value",
      control: "data_source_field",
    };
    expect(resolveDataSourceKey(field, [sourceField, field])).toBe(
      "primarySource",
    );
  });

  it("honors an explicit dataSourceKey when several sources exist", () => {
    const field: ContentDefinitionField = {
      key: "compareField",
      label: "Compare value",
      control: "data_source_field",
      dataSourceKey: "compareSource",
    };
    expect(
      resolveDataSourceKey(field, [sourceField, secondSource, field]),
    ).toBe("compareSource");
  });

  // Guessing here is what produced the original defect: a second field picker silently listed
  // the first source's schema. With no way to know, offer nothing.
  it("resolves nothing when several sources exist and the field does not say which", () => {
    const field: ContentDefinitionField = {
      key: "valueField",
      label: "Value",
      control: "data_source_field",
    };
    expect(
      resolveDataSourceKey(field, [sourceField, secondSource, field]),
    ).toBeUndefined();
  });
});

describe("dataFormatGuideFor", () => {
  it("derives field roles, accepted types, and an example from the Widget definition", () => {
    const fields: ContentDefinitionField[] = [
      {
        key: "dataSourceId",
        label: "Schedule data",
        control: "data_source",
        acceptedDataSourceKinds: ["records"],
      },
      {
        key: "titleField",
        label: "Title field",
        control: "data_source_field",
        required: true,
        default: "title",
        dataSourceFieldTypes: ["text"],
      },
      {
        key: "startField",
        label: "Start field",
        control: "data_source_field",
        required: true,
        default: "start",
        dataSourceFieldTypes: ["datetime"],
      },
    ];

    expect(dataFormatGuideFor(fields[0]!, fields)).toEqual({
      shape: "Record rows",
      summary:
        "Use these field roles and types. Field names can differ because you map them below.",
      fields: [
        {
          key: "title",
          label: "Title field",
          types: ["text"],
          required: true,
        },
        {
          key: "start",
          label: "Start field",
          types: ["datetime"],
          required: true,
        },
      ],
      example: {
        title: "Period 2",
        start: "2026-08-24T09:03:00-04:00",
      },
    });
  });

  it("merges a required field and a mapped control that describe the same key", () => {
    const fields: ContentDefinitionField[] = [
      {
        key: "dataSourceId",
        label: "Schedule data",
        control: "data_source",
        requiredFields: { start_time: "datetime" },
      },
      {
        key: "startTimeField",
        label: "Start field",
        control: "data_source_field",
        default: "start_time",
        dataSourceFieldTypes: ["date"],
      },
    ];

    const guide = dataFormatGuideFor(fields[0]!, fields);

    expect(guide.fields).toEqual([
      {
        key: "start_time",
        label: "start time",
        types: ["datetime", "date"],
        required: true,
      },
    ]);
    expect(guide.example).toEqual({
      start_time: "2026-08-24T09:03:00-04:00",
    });
  });
});

describe("DefinitionForm data source controls", () => {
  it("offers only Data Sources whose output schema the field accepts", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(
      catalog([
        definition("csv", [{ key: "title", label: "Title", type: "text" }]),
        definition("weather", [
          { key: "temperature", label: "Temperature", type: "number" },
        ]),
      ]),
    );
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [
        source("s-csv", "csv", "Lunch rows"),
        source("s-weather", "weather", "Campus weather"),
      ],
      total: 2,
      page: 1,
      pageSize: 100,
    });

    form([
      {
        key: "dataSourceId",
        label: "Data",
        control: "data_source",
        requiredFields: { temperature: "number" },
      },
    ]);

    // The Data Source control is a chooser rather than a dropdown, so compatibility is read from
    // what the chooser dialog offers. The field pickers below are still selects.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Data: / })).toHaveTextContent(
        "1 compatible source",
      ),
    );
    expect(screen.getByText("Data format")).toBeTruthy();
    // The field appears both as a required role and in the example row beneath it.
    expect(screen.getAllByText("temperature")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: /^Data: / }));

    const chooser = await screen.findByRole("dialog", { name: "Choose data" });
    expect(within(chooser).getByText("Campus weather")).toBeTruthy();
    expect(within(chooser).queryByText("Lunch rows")).toBeNull();
  });

  it("explains the empty state and offers to connect data instead of disabling the control", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(
      catalog([definition("csv", [])]),
    );
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });

    form([{ key: "dataSourceId", label: "Data", control: "data_source" }]);

    await waitFor(() =>
      expect(screen.getByText("No compatible data connected yet")).toBeTruthy(),
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Connect new data/ }),
    ).toBeEnabled();
  });

  it("offers the compatible providers when connecting new data", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(
      catalog([definition("csv", []), definition("form", [])]),
    );
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });

    form([{ key: "dataSourceId", label: "Data", control: "data_source" }]);

    const connect = await screen.findByRole("button", {
      name: /Connect new data/,
    });
    await userEvent.click(connect);

    // Connecting from a Widget runs the same provider gallery as the Data Sources page.
    expect(await screen.findByRole("dialog")).toHaveAccessibleName(
      "Create Data Source",
    );
    expect(screen.getByRole("button", { name: /csv source/ })).toBeTruthy();
    // Form Data Sources are authored in the Forms portal, never through this editor.
    expect(screen.queryByRole("button", { name: /form source/ })).toBeNull();
  });

  // Without narrowing, an author could connect a provider the field then refuses, leaving them
  // with a new Data Source that does not appear in the picker they created it from.
  it("offers only providers the field accepts when connecting new data", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(
      catalog([
        definition("csv", [{ key: "title", label: "Title", type: "text" }]),
        definition("weather", [
          { key: "temperature", label: "Temperature", type: "number" },
        ]),
      ]),
    );
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });

    form([
      {
        key: "dataSourceId",
        label: "Data",
        control: "data_source",
        requiredFields: { temperature: "number" },
      },
    ]);

    await userEvent.click(
      await screen.findByRole("button", { name: /Connect new data/ }),
    );

    expect(screen.getByRole("button", { name: /weather source/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /csv source/ })).toBeNull();
  });

  it("resolves each field picker against its own Data Source", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(
      catalog([definition("csv", [])]),
    );
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [
        source("primary", "csv", "Primary"),
        source("compare", "csv", "Compare"),
      ],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    vi.spyOn(api, "getDataSource").mockImplementation((id: string) =>
      Promise.resolve(
        id === "primary"
          ? detail("primary", [{ key: "lunch", label: "Lunch", type: "text" }])
          : detail("compare", [
              { key: "dinner", label: "Dinner", type: "text" },
            ]),
      ),
    );

    form(
      [
        { key: "primarySource", label: "Primary", control: "data_source" },
        { key: "compareSource", label: "Compare", control: "data_source" },
        {
          key: "primaryField",
          label: "Primary field",
          control: "data_source_field",
          dataSourceKey: "primarySource",
        },
        {
          key: "compareField",
          label: "Compare field",
          control: "data_source_field",
          dataSourceKey: "compareSource",
        },
      ],
      { primarySource: "primary", compareSource: "compare" },
    );

    // Each picker lists only its own source's fields. Before the fix both listed the source at
    // the hardcoded `dataSourceId` key, so the second picker showed the wrong schema.
    await waitFor(async () =>
      expect(await optionsFor("Primary field")).toContain("Lunch (text)"),
    );
    await waitFor(async () =>
      expect(await optionsFor("Compare field")).toContain("Dinner (text)"),
    );
    expect(await optionsFor("Primary field")).not.toContain("Dinner (text)");
    expect(await optionsFor("Compare field")).not.toContain("Lunch (text)");
  });

  it("tells the author to choose a Data Source before offering fields", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(
      catalog([definition("csv", [])]),
    );
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [source("primary", "csv", "Primary")],
      total: 1,
      page: 1,
      pageSize: 100,
    });

    form([
      { key: "primarySource", label: "Primary", control: "data_source" },
      {
        key: "primaryField",
        label: "Primary field",
        control: "data_source_field",
      },
    ]);

    await waitFor(async () =>
      expect(await optionsFor("Primary field")).toEqual([
        "Select a Data Source first",
      ]),
    );
  });

  it("renders boolean fields as aligned labeled switches", async () => {
    vi.spyOn(api, "contentDefinitions").mockResolvedValue(catalog([]));
    const { onChange } = form(
      [
        {
          key: "showCountdown",
          label: "Show live countdown",
          description: "Show the current event countdown.",
          control: "boolean",
        },
      ],
      { showCountdown: true },
    );

    const toggle = screen.getByRole("switch", {
      name: "Show live countdown",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Show the current event countdown.")).toBeVisible();

    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ showCountdown: false });
  });
});
