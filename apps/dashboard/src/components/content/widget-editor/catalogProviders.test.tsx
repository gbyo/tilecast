// @vitest-environment jsdom
// The migration gate: every Widget definition this release ships opens in
// the one Widget editor. New types start from their defaults, render a
// preview or say why not, validate, save, and reopen clean. Superseded
// types that saved content still references open the same way.
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  groupAuthoringFields,
  visibleAuthoringFields,
} from "@tilecast/widget-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import type { Asset, WidgetDefinition } from "@/api/types";
import { describesAuthoring, widgetAuthoring } from "./widgetAuthoring";
import { initialConfiguration, initialDraft } from "./widgetEditorModel";
import { validateWidgetDraft } from "./widgetEditorValidation";
import {
  mockEditorApi,
  renderEditorRoute,
  repositoryCatalog,
  savedWidget,
} from "./testing";
import { resetWidgetSnapshotQueue } from "./snapshotQueue";

vi.mock("@/content/widgetPreviewCapture", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/content/widgetPreviewCapture")>();
  return {
    ...actual,
    captureWidgetPreview: vi.fn(() =>
      Promise.resolve(new Blob(["preview"], { type: "image/jpeg" })),
    ),
  };
});

beforeEach(() => resetWidgetSnapshotQueue());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const catalog = repositoryCatalog();
const available = catalog.widgets.filter(
  (definition) => definition.availability?.enabled !== false,
);
const creatable = available.filter(
  (definition) => !definition.deprecation?.deprecated,
);
const superseded = available.filter(
  (definition) => definition.deprecation?.deprecated,
);
const sectionNames = {
  data: "Data",
  content: "Content",
  appearance: "Style",
  behavior: "Behavior",
} as const;

function webPreview() {
  vi.spyOn(api, "compileWidgetPreview").mockResolvedValue({
    schemaVersion: 1,
    kind: "web",
    requiredCapabilities: {},
    web: { url: "https://example.com/embed" },
  } as never);
}

function expectSections(definition: WidgetDefinition) {
  const groups = groupAuthoringFields(
    visibleAuthoringFields(
      definition.configurationSchema.fields,
      initialConfiguration(
        definition,
        widgetAuthoring(definition, catalog),
        undefined,
      ),
    ),
  );
  if (groups.length > 1) {
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(
      groups.map((group) => sectionNames[group.section]),
    );
  } else if (groups.length === 1) {
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(
      screen.getByRole("heading", {
        name: sectionNames[groups[0]!.section],
      }),
    ).toBeTruthy();
  }
}

describe("every shipped Widget type", () => {
  it("are mostly ready to save as created", () => {
    // Only types that cannot have a sensible default (an address, a
    // feed) ask for input first.
    const needingInput = creatable
      .filter((definition) => {
        const authoring = widgetAuthoring(definition, catalog);
        return (
          authoring.kind !== "unsupported" &&
          !validateWidgetDraft(
            definition,
            initialDraft(definition, authoring, undefined, "New"),
            ((key: string) => key) as never,
          ).valid
        );
      })
      .map((definition) => definition.id)
      .sort();
    expect(needingInput).toMatchSnapshot();
  });

  it("describes itself to the editor", () => {
    for (const definition of available) {
      expect(describesAuthoring(definition), definition.id).toBe(true);
      expect(widgetAuthoring(definition, catalog).kind, definition.id).not.toBe(
        "unsupported",
      );
    }
  });

  it.each(creatable.map((definition) => [definition.id, definition] as const))(
    "%s opens, previews, saves, and reopens",
    async (id, definition) => {
      mockEditorApi({ catalog });
      if (definition.runtime === "web") webPreview();
      let saved: Asset | undefined;
      const create = vi
        .spyOn(api, "createWidget")
        .mockImplementation((input) => {
          saved = savedWidget(id, input.configuration, {
            id: "widget-9",
            name: input.name,
          });
          return Promise.resolve(saved);
        });
      vi.spyOn(api, "asset").mockImplementation(() => Promise.resolve(saved!));
      renderEditorRoute(`/widgets/new/${id}`);
      const save = await screen.findByRole(
        "button",
        { name: /Save Widget/ },
        { timeout: 4000 },
      );
      expectSections(definition);
      // A preview, or a reason there is none.
      await waitFor(() =>
        expect(
          screen.queryByRole("img", { name: "Live Widget preview" }) ??
            screen.queryAllByRole("status")[0],
        ).toBeTruthy(),
      );
      await userEvent.click(save);
      const authoring = widgetAuthoring(definition, catalog);
      if (authoring.kind === "unsupported") throw new Error(id);
      const needsInput = !validateWidgetDraft(
        definition,
        initialDraft(definition, authoring, undefined, "New"),
        ((key: string) => key) as never,
      ).valid;
      if (needsInput) {
        // Types whose defaults need an author's input say what is missing
        // instead of saving.
        expect(create).not.toHaveBeenCalled();
        expect(screen.queryAllByRole("alert").length).toBeGreaterThan(0);
        return;
      }
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0]![0].provider).toBe(id);
      expect(
        await screen.findByRole(
          "button",
          { name: /Save changes/ },
          { timeout: 4000 },
        ),
      ).toBeDisabled();
      expect(screen.getByText("Saved")).toBeTruthy();
    },
    15_000,
  );

  it.each(superseded.map((definition) => [definition.id, definition] as const))(
    "superseded %s still opens saved content clean",
    async (id, definition) => {
      const asset = savedWidget(id, {
        ...definition.defaultConfiguration,
      });
      mockEditorApi({ catalog, asset });
      if (definition.runtime === "web") webPreview();
      renderEditorRoute("/widgets/widget-1");
      expect(
        await screen.findByRole(
          "button",
          { name: /Save changes/ },
          { timeout: 4000 },
        ),
      ).toBeDisabled();
      expect(screen.queryByText("Widget type unavailable")).toBeNull();
    },
    15_000,
  );
});
