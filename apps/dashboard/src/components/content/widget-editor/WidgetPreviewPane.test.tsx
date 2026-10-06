// @vitest-environment jsdom
// The preview is a way of looking at the Widget. Nothing done to the
// preview changes the draft, and preview health never decides a save.
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { toast } from "@/components/ui/toast";
import { captureWidgetPreview } from "@/content/widgetPreviewCapture";
import {
  mockEditorApi,
  renderEditorRoute,
  repositoryCatalog,
  savedWidget,
  useViewport,
} from "./testing";
import { resetWidgetSnapshotQueue } from "./WidgetSnapshotQueue";

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

beforeEach(() => {
  resetWidgetSnapshotQueue();
  useViewport("tablet");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const text = savedWidget("text", {
  heading: "Lunch",
  body: "Pizza today",
  style: "standard",
  align: "center",
  backgroundColor: "#0e141b",
  foregroundColor: "#f5f7fa",
});

const clock = savedWidget("clock", {
  mode: "time",
  timezone: "",
  zones: [],
  dateFormat: "locale",
  format: "locale",
  showSeconds: false,
  style: "standard",
  showDate: false,
  backgroundColor: "#0e141b",
  foregroundColor: "#f5f7fa",
});

async function open(asset = text, save: RegExp = /Save changes/) {
  mockEditorApi({ asset });
  const view = renderEditorRoute("/widgets/widget-1");
  await screen.findByRole("button", { name: save }, { timeout: 4000 });
  return view;
}

function toolbar() {
  return screen.getByRole("toolbar", { name: "Preview controls" });
}

describe("Widget preview", () => {
  it("renders the real Widget component, the one the Player mounts", async () => {
    await open();
    const frame = await screen.findByRole("img", {
      name: "Live Widget preview",
    });
    await waitFor(() =>
      expect(frame.querySelector("tc-widget-text")).not.toBeNull(),
    );
    expect(api.compileWidgetPreview).not.toHaveBeenCalled();
  });

  it("starts strip-native Widgets at their recommended authoring frame", async () => {
    const catalog = repositoryCatalog();
    const definition = catalog.widgets.find(
      (entry) => entry.id === "alert-banner",
    );
    expect(definition?.authoring?.recommendedFrame).toEqual({
      width: 1920,
      height: 160,
    });
    const alert = savedWidget(
      "alert-banner",
      structuredClone(definition?.defaultConfiguration ?? {}),
    );
    mockEditorApi({ catalog, asset: alert });
    renderEditorRoute("/widgets/widget-1");
    await screen.findByRole("button", { name: /Save changes/ });
    const bar = toolbar();
    expect(
      within(bar).getByRole("combobox", { name: "Preview frame" }),
    ).toHaveTextContent("Custom size");
    expect(
      within(bar).getByRole("button", {
        name: "Custom size, 1920 by 160 pixels",
      }),
    ).toBeTruthy();
  });

  it("changes frame, size, zoom, and fullscreen without touching the draft", async () => {
    await open();
    const bar = toolbar();
    await userEvent.click(
      within(bar).getByRole("combobox", { name: "Preview frame" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Custom size" }),
    );
    await userEvent.click(
      within(bar).getByRole("button", {
        name: "Custom size, 960 by 540 pixels",
      }),
    );
    const width = await screen.findByRole("spinbutton", { name: "Width (px)" });
    fireEvent.change(width, { target: { value: "600" } });
    expect(
      within(bar).getByRole("button", {
        name: "Custom size, 600 by 540 pixels",
      }),
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    const fit = within(bar).getByRole("button", { name: /Fit to window/ });
    expect(fit).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(bar).getByRole("button", { name: "Zoom in" }));
    expect(fit).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(fit);
    expect(fit).toHaveAttribute("aria-pressed", "true");
    const fullscreen = within(bar).getByRole("button", {
      name: "Fullscreen preview",
    });
    await userEvent.click(fullscreen);
    expect(
      within(bar).getByRole("button", { name: "Exit fullscreen" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("{Escape}");
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  });

  it("offers preview time only for Widgets that depend on it", async () => {
    await open(text);
    expect(
      within(toolbar()).queryByRole("button", { name: /Preview time/ }),
    ).toBeNull();
    cleanup();
    vi.restoreAllMocks();
    useViewport("tablet");
    await open(clock);
    const time = within(toolbar()).getByRole("button", {
      name: "Preview time: live",
    });
    await userEvent.click(time);
    await userEvent.click(
      await screen.findByRole("button", { name: "At a time" }),
    );
    await waitFor(() =>
      expect(
        within(toolbar()).getByRole("button", {
          name: /Preview time: (?!live)/,
        }),
      ).toBeTruthy(),
    );
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("names the preview region and its controls", async () => {
    await open();
    expect(screen.getByRole("region", { name: "Preview" })).toBeTruthy();
    expect(
      within(toolbar()).getByRole("button", { name: "Zoom out" }),
    ).toBeTruthy();
  });

  it("splits preview and settings with a keyboard-resizable handle on desktop", async () => {
    cleanup();
    useViewport("desktop");
    await open();
    const handle = screen.getByRole("separator", {
      name: "Resize the preview and settings",
    });
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(
      screen.getByRole("region", { name: "Widget settings" }),
    ).toBeTruthy();
  });

  it("keeps a compact toolbar on a phone, without zoom", async () => {
    cleanup();
    useViewport("phone");
    await open(text, /^Save$/);
    expect(
      within(toolbar()).queryByRole("button", { name: "Zoom out" }),
    ).toBeNull();
    expect(
      within(toolbar()).getByRole("button", { name: "Fullscreen preview" }),
    ).toBeTruthy();
  });
});

describe("Widget thumbnails", () => {
  it("saves first and uploads the canonical thumbnail afterward", async () => {
    await open();
    const order: string[] = [];
    vi.spyOn(api, "updateWidget").mockImplementation(() => {
      order.push("save");
      return Promise.resolve(text);
    });
    const upload = vi
      .spyOn(api, "uploadWidgetPreview")
      .mockImplementation(() => {
        order.push("upload");
        return Promise.resolve();
      });
    fireEvent.change(screen.getByRole("textbox", { name: /Message/ }), {
      target: { value: "Tacos today" },
    });
    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1), {
      timeout: 4000,
    });
    expect(order).toEqual(["save", "upload"]);
    expect(upload.mock.calls[0]![0]).toBe("widget-1");
  });

  it("keeps the save when the thumbnail cannot be captured", async () => {
    await open();
    vi.mocked(captureWidgetPreview).mockRejectedValueOnce(
      new Error("Preview canvas is unavailable."),
    );
    const warn = vi.spyOn(toast, "add");
    vi.spyOn(api, "updateWidget").mockResolvedValue(text);
    const upload = vi.spyOn(api, "uploadWidgetPreview");
    fireEvent.change(screen.getByRole("textbox", { name: /Message/ }), {
      target: { value: "Tacos today" },
    });
    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    await waitFor(
      () =>
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Preview thumbnail could not be updated.",
            type: "warning",
          }),
        ),
      { timeout: 4000 },
    );
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByText("Saved")).toBeTruthy();
  });
});
