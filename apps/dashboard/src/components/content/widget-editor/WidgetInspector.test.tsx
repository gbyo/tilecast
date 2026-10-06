// @vitest-environment jsdom
// Every control the Widget definition vocabulary declares, rendered by the
// one inspector with programmatic labels, values, and changes.
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import type {
  ContentDefinitionCatalog,
  ContentDefinitionField,
  DataSource,
  DataSourceDefinition,
  WidgetDefinition,
} from "@/api/types";
import {
  definitionFrom,
  mockEditorApi,
  renderEditorRoute,
  repositoryCatalog,
  savedWidget,
} from "./testing";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fields: ContentDefinitionField[] = [
  {
    key: "title",
    label: "Title",
    control: "text",
    required: true,
    maxLength: 40,
    ui: { section: "content", order: 2 },
  },
  {
    key: "intro",
    label: "Intro",
    description: "A short paragraph.",
    control: "multiline_text",
    ui: { section: "content", order: 1 },
  },
  {
    key: "link",
    label: "Link",
    control: "url",
    ui: { section: "content", order: 3 },
  },
  {
    key: "ratio",
    label: "Ratio",
    control: "number",
    minimum: 0,
    maximum: 1,
    ui: { section: "content", order: 4 },
  },
  {
    key: "volume",
    label: "Volume",
    control: "integer",
    minimum: 0,
    maximum: 100,
    ui: { section: "behavior", order: 1, slider: true },
  },
  {
    key: "loop",
    label: "Loop",
    control: "boolean",
    ui: { section: "behavior", order: 2 },
  },
  {
    key: "speed",
    label: "Speed",
    control: "select",
    options: [
      { value: "slow", label: "Slow" },
      { value: "fast", label: "Fast" },
    ],
    ui: { section: "behavior", order: 3 },
  },
  {
    key: "pace",
    label: "Pace",
    control: "integer",
    minimum: 1,
    maximum: 10,
    ui: {
      section: "behavior",
      order: 4,
      visibleWhen: { key: "speed", equals: "fast" },
    },
  },
  {
    key: "style",
    label: "Look",
    control: "select",
    options: [
      { value: "plain", label: "Plain" },
      { value: "bold", label: "Bold" },
    ],
    ui: { section: "appearance", order: 1, styleCard: true },
  },
  {
    key: "tint",
    label: "Tint",
    control: "color",
    ui: { section: "appearance", order: 2 },
  },
  {
    key: "day",
    label: "Day",
    control: "date",
    ui: { section: "content", order: 5 },
  },
  {
    key: "at",
    label: "At",
    control: "datetime",
    ui: { section: "content", order: 6 },
  },
  {
    key: "local",
    label: "Local time",
    control: "local_datetime",
    ui: { section: "content", order: 7 },
  },
  {
    key: "zone",
    label: "Zone",
    control: "timezone",
    ui: { section: "content", order: 8 },
  },
  {
    key: "currency",
    label: "Currency",
    control: "currency_code",
    ui: { section: "content", order: 9 },
  },
  {
    key: "image",
    label: "Image",
    control: "media_asset",
    mediaTypes: ["image"],
    ui: { section: "content", order: 10 },
  },
  {
    key: "hosts",
    label: "Hosts",
    control: "string_list",
    maximumItems: 3,
    ui: { section: "behavior", order: 5, advanced: true },
  },
  { key: "secret", label: "Secret", control: "integer", ui: { hidden: true } },
  {
    key: "stops",
    label: "Stops",
    control: "repeating_group",
    maximumItems: 2,
    ui: { section: "content", order: 11 },
    itemFields: [
      { key: "name", label: "Stop name", control: "text" },
      { key: "minutes", label: "Minutes", control: "integer" },
    ],
  },
  {
    key: "dataSourceId",
    label: "Menu data",
    control: "data_source",
    acceptedDataSourceKinds: ["records"],
    ui: { section: "data", order: 1 },
  },
  {
    key: "itemField",
    label: "Item name",
    control: "data_source_field",
    dataSourceFieldTypes: ["text"],
    ui: { section: "data", order: 2, semanticRole: "title" },
  },
];

const configuration = {
  title: "Hello",
  intro: "",
  link: "",
  volume: 40,
  loop: false,
  speed: "slow",
  style: "plain",
  tint: "",
  hosts: ["a.example"],
  stops: [{ name: "Main gate", minutes: 3 }],
  dataSourceId: "",
  itemField: "",
};

function kitchenSink(): ContentDefinitionCatalog {
  const catalog = repositoryCatalog();
  const text = definitionFrom(catalog, "text");
  const sink: WidgetDefinition = {
    ...text,
    id: "kitchen-sink",
    name: "Kitchen Sink",
    configurationSchema: { fields },
    defaultConfiguration: configuration,
    authoring: undefined,
  };
  catalog.widgets.push(sink);
  const menu: DataSourceDefinition = {
    id: "menu-test",
    version: 1,
    name: "Menu",
    description: "",
    category: "Data",
    icon: "table",
    configurationSchema: { fields: [] },
    defaultConfiguration: {},
    outputSchema: {
      kind: "records",
      fields: [{ key: "dish", label: "Dish", type: "text" }],
    },
    adapterId: "test",
    refreshBehavior: "manual",
  };
  catalog.dataSources.push(menu);
  return catalog;
}

function source(id: string, name: string, provider = "menu-test"): DataSource {
  return {
    id,
    provider,
    name,
    description: "",
    configVersion: 1,
    configuration: {},
    status: "ready",
    cachedRecordCount: 32,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

async function openSink(role: "owner" | "viewer" = "owner") {
  mockEditorApi({
    catalog: kitchenSink(),
    asset: savedWidget("kitchen-sink", configuration),
    role,
  });
  vi.spyOn(api, "listDataSources").mockResolvedValue({
    items: [
      source("s-menu", "Lunch Menu"),
      source("s-other", "Other", "retired-provider"),
    ],
    total: 2,
    page: 1,
    pageSize: 100,
  });
  vi.spyOn(api, "getDataSource").mockResolvedValue({
    ...source("s-menu", "Lunch Menu"),
    fields: [
      { key: "dish", label: "Dish", type: "text", role: "title" },
      { key: "notes", label: "Notes", type: "text" },
    ],
  } as never);
  renderEditorRoute("/widgets/widget-1");
  await screen.findByRole("tab", { name: "Content" }, { timeout: 4000 });
}

async function tab(name: string) {
  const trigger = screen.getByRole("tab", { name });
  await userEvent.click(trigger);
  // A panel that is leaving can linger for a frame; take the tab's own.
  return document.getElementById(trigger.getAttribute("aria-controls")!)!;
}

describe("Widget inspector", () => {
  it("shows only non-empty sections, in canonical order", async () => {
    await openSink();
    expect(
      screen.getAllByRole("tab").map((entry) => entry.textContent),
    ).toEqual(["Data", "Content", "Style", "Behavior"]);
  });

  it("orders fields by their declared order and hides retained fields", async () => {
    await openSink();
    const panel = await tab("Content");
    const labels = within(panel)
      .getAllByText(/^(Intro|Title\*?|Link)$/)
      .map((label) => label.textContent?.replace("*", ""));
    expect(labels).toEqual(["Intro", "Title", "Link"]);
    expect(screen.queryByText("Secret")).toBeNull();
  });

  it("labels text, multiline, url, number, date, and currency controls", async () => {
    await openSink();
    const panel = await tab("Content");
    const title = within(panel).getByRole("textbox", { name: /Title/ });
    expect(title).toHaveValue("Hello");
    expect(title).toHaveAttribute("aria-required", "true");
    expect(
      within(panel).getByRole("textbox", { name: "Intro" }),
    ).toHaveAccessibleDescription("A short paragraph.");
    expect(
      within(panel).getByRole("textbox", { name: "Link" }),
    ).toHaveAttribute("type", "url");
    expect(
      within(panel).getByRole("spinbutton", { name: "Ratio" }),
    ).toBeTruthy();
    expect(
      within(panel).getByRole("textbox", { name: "Currency" }),
    ).toBeTruthy();
    expect(within(panel).getByLabelText("Day")).toBeTruthy();
    expect(within(panel).getByLabelText("At")).toBeTruthy();
    expect(within(panel).getByLabelText("Local time")).toBeTruthy();
    fireEvent.change(title, { target: { value: "Changed" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("offers time zones with the organization's zone first", async () => {
    await openSink();
    const panel = await tab("Content");
    const zone = within(panel).getByRole("combobox", { name: "Zone" });
    expect(zone).toHaveValue("Organization time zone (UTC)");
  });

  it("renders a switch, a select, and conditional fields", async () => {
    await openSink();
    let panel = await tab("Behavior");
    const loop = within(panel).getByRole("switch", { name: "Loop" });
    expect(loop).not.toBeChecked();
    await userEvent.click(loop);
    expect(loop).toBeChecked();
    expect(
      within(panel).queryByRole("spinbutton", { name: "Pace" }),
    ).toBeNull();
    await userEvent.click(
      within(panel).getByRole("combobox", { name: "Speed" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: "Fast" }));
    panel = document.getElementById(
      screen
        .getByRole("tab", { name: "Behavior" })
        .getAttribute("aria-controls")!,
    )!;
    expect(
      within(panel).getByRole("spinbutton", { name: "Pace" }),
    ).toBeTruthy();
  });

  it("pairs a bounded number's slider with its input under one label", async () => {
    await openSink();
    const panel = await tab("Behavior");
    expect(
      within(panel).getByRole("spinbutton", { name: "Volume" }),
    ).toHaveValue(40);
    // The thumb is laid out by the browser; jsdom leaves it unmeasured,
    // so this checks the slider's label wiring directly.
    const slider = within(panel).getByRole("slider", { hidden: true });
    expect(slider).toHaveAttribute("aria-valuenow", "40");
    expect(
      document.getElementById(slider.getAttribute("aria-labelledby")!),
    ).toHaveTextContent("Volume");
  });

  it("renders visual choices as a labeled radio group", async () => {
    await openSink();
    const panel = await tab("Style");
    const group = within(panel).getByRole("radiogroup", { name: "Look" });
    expect(within(group).getByRole("radio", { name: "Plain" })).toBeChecked();
    await userEvent.click(within(group).getByRole("radio", { name: "Bold" }));
    expect(within(group).getByRole("radio", { name: "Bold" })).toBeChecked();
    expect(
      within(panel).getByRole("textbox", { name: "Tint" }),
    ).toHaveAttribute("placeholder", "Theme default");
  });

  it("keeps rare settings under Advanced and edits a string list", async () => {
    await openSink();
    const panel = await tab("Behavior");
    expect(
      within(panel).queryByRole("textbox", { name: "Hosts 1" }),
    ).toBeNull();
    await userEvent.click(
      within(panel).getByRole("button", { name: "Advanced" }),
    );
    expect(within(panel).getByRole("textbox", { name: "Hosts 1" })).toHaveValue(
      "a.example",
    );
    await userEvent.click(
      within(panel).getByRole("button", { name: "Add entry" }),
    );
    expect(within(panel).getByRole("textbox", { name: "Hosts 2" })).toHaveValue(
      "",
    );
    await userEvent.click(
      within(panel).getByRole("button", { name: "Remove Hosts 1" }),
    );
    expect(within(panel).getByRole("textbox", { name: "Hosts 1" })).toHaveValue(
      "",
    );
  });

  it("names repeating items by their content and respects the item limit", async () => {
    await openSink();
    const panel = await tab("Content");
    const item = within(panel).getByRole("button", { name: "Main gate" });
    await userEvent.click(item);
    expect(
      within(panel).getByRole("textbox", { name: "Stop name" }),
    ).toHaveValue("Main gate");
    await userEvent.click(
      within(panel).getByRole("button", { name: "Add item" }),
    );
    expect(within(panel).getByRole("button", { name: "Item 2" })).toBeTruthy();
    expect(
      within(panel).queryByRole("button", { name: "Add item" }),
    ).toBeNull();
    expect(
      within(panel).getByText("This list holds up to 2 items."),
    ).toBeTruthy();
    await userEvent.click(
      within(panel).getByRole("button", { name: "Remove Main gate" }),
    );
    expect(
      within(panel).queryByRole("button", { name: "Main gate" }),
    ).toBeNull();
  });

  it("shows a media selection as a resource row with a picker", async () => {
    await openSink();
    const panel = await tab("Content");
    expect(within(panel).getByText("None selected")).toBeTruthy();
    expect(
      within(panel).getByRole("button", { name: "Choose Image" }),
    ).toBeTruthy();
  });

  it("disables every control for a viewer", async () => {
    await openSink("viewer");
    const panel = await tab("Content");
    expect(
      within(panel).getByRole("textbox", { name: /Title/ }),
    ).toBeDisabled();
    expect(
      within(panel).queryByRole("button", { name: "Add item" }),
    ).toBeNull();
    expect(
      within(panel).queryByRole("button", { name: "Choose Image" }),
    ).toBeNull();
  });

  describe("Data", () => {
    it("lists only compatible sources and maps fields automatically", async () => {
      await openSink();
      const panel = await tab("Data");
      expect(within(panel).getByText("No data connected")).toBeTruthy();
      expect(
        await within(panel).findByText("1 compatible source"),
      ).toBeTruthy();
      await userEvent.click(
        within(panel).getByRole("combobox", { name: "Choose Menu data" }),
      );
      expect(
        await screen.findByRole("option", { name: /Lunch Menu/ }),
      ).toBeTruthy();
      expect(screen.queryByRole("option", { name: /Other/ })).toBeNull();
      await userEvent.click(screen.getByRole("option", { name: /Lunch Menu/ }));
      await waitFor(() =>
        expect(within(panel).getByText("Lunch Menu")).toBeTruthy(),
      );
      expect(within(panel).getByText(/Ready · 32 records/)).toBeTruthy();
      const mapping = within(panel).getByRole("combobox", {
        name: "Item name",
      });
      await waitFor(() => expect(mapping).toHaveTextContent("Dish"));
      expect(mapping).toHaveAccessibleDescription("Auto");
    });

    it("keeps an author's choice and marks it Custom", async () => {
      await openSink();
      const panel = await tab("Data");
      await userEvent.click(
        within(panel).getByRole("combobox", { name: "Choose Menu data" }),
      );
      await userEvent.click(
        await screen.findByRole("option", { name: /Lunch Menu/ }),
      );
      const mapping = within(panel).getByRole("combobox", {
        name: "Item name",
      });
      await waitFor(() => expect(mapping).toHaveTextContent("Dish"));
      await userEvent.click(mapping);
      await userEvent.click(
        await screen.findByRole("option", { name: "Notes" }),
      );
      expect(mapping).toHaveTextContent("Notes");
      expect(mapping).toHaveAccessibleDescription("Custom");
    });
  });
});
