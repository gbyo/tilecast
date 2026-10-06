// @vitest-environment jsdom
// The Widget editor route: one editor for every Widget type, one return
// protocol, one unsaved-changes rule, and an explicit Save.
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
import { api, ApiError } from "../api/client";
import type { Asset } from "../api/types";
import {
  mockEditorApi,
  renderEditorRoute,
  repositoryCatalog,
  savedWidget,
} from "../components/content/widget-editor/testing";
import { resetWidgetSnapshotQueue } from "../components/content/widget-editor/snapshotQueue";

vi.mock("../content/widgetPreviewCapture", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../content/widgetPreviewCapture")>();
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

const textConfiguration = {
  heading: "Lunch",
  body: "Pizza today",
  style: "standard",
  align: "center",
  backgroundColor: "#0e141b",
  foregroundColor: "#f5f7fa",
};

function textWidget(overrides: Partial<Asset> = {}) {
  return savedWidget("text", textConfiguration, {
    name: "Lunch Notice",
    ...overrides,
  });
}

function path() {
  return screen.getByTestId("path").textContent;
}

async function editorReady(saveName: RegExp = /Save changes/) {
  return screen.findByRole("button", { name: saveName }, { timeout: 4000 });
}

async function editMessage(text: string) {
  const message = await screen.findByRole("textbox", { name: /Message/ });
  fireEvent.change(message, { target: { value: text } });
  return message;
}

describe("Widget editor route", () => {
  describe("returning", () => {
    it("closes a clean editor straight back to Widgets", async () => {
      mockEditorApi({ asset: textWidget() });
      renderEditorRoute("/widgets/widget-1");
      await editorReady();
      await userEvent.click(
        screen.getByRole("button", { name: "Back to Widgets" }),
      );
      await waitFor(() => expect(path()).toBe("/widgets"));
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("returns to the Layout that opened the Widget", async () => {
      mockEditorApi({ asset: textWidget() });
      renderEditorRoute("/widgets/widget-1?returnTo=%2Flayouts%2Flayout-1");
      await editorReady();
      await userEvent.click(
        screen.getByRole("button", { name: "Back to Layout" }),
      );
      await waitFor(() => expect(path()).toBe("/layouts/layout-1"));
    });

    it("ignores a return path that is not an in-app route", async () => {
      mockEditorApi({ asset: textWidget() });
      renderEditorRoute("/widgets/widget-1?returnTo=%2F%2Fevil.example.com");
      await editorReady();
      await userEvent.click(
        screen.getByRole("button", { name: "Back to Widgets" }),
      );
      await waitFor(() => expect(path()).toBe("/widgets"));
    });

    it("names a Widget created on this trip on the way back to the playlist", async () => {
      mockEditorApi({ asset: textWidget() });
      renderEditorRoute(
        "/widgets/widget-1?returnTo=%2Fplaylists%2Fplaylist-1&created=1",
      );
      await editorReady();
      await userEvent.click(
        screen.getByRole("button", { name: "Back to Playlist" }),
      );
      await waitFor(() =>
        expect(path()).toBe("/playlists/playlist-1?newWidget=widget-1"),
      );
    });

    it("does not name a Widget that was only edited", async () => {
      mockEditorApi({ asset: textWidget() });
      renderEditorRoute("/widgets/widget-1?returnTo=%2Fplaylists%2Fplaylist-1");
      await editorReady();
      await userEvent.click(
        screen.getByRole("button", { name: "Back to Playlist" }),
      );
      await waitFor(() => expect(path()).toBe("/playlists/playlist-1"));
    });
  });

  describe("unsaved changes", () => {
    it("asks before leaving, and Keep editing keeps the draft", async () => {
      mockEditorApi({ asset: textWidget() });
      renderEditorRoute("/widgets/widget-1");
      await editorReady();
      const message = await editMessage("Tacos today");
      await userEvent.click(
        screen.getByRole("button", { name: "Back to Widgets" }),
      );
      const dialog = await screen.findByRole("alertdialog", {
        name: "Discard unsaved changes?",
      });
      expect(dialog).toHaveTextContent(
        "Your changes to “Lunch Notice” haven't been saved.",
      );
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Keep editing" }),
      );
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(path()).toBe("/widgets/widget-1");
      expect(message).toHaveValue("Tacos today");
    });

    it("leaves when the change is discarded", async () => {
      mockEditorApi({ asset: textWidget() });
      renderEditorRoute("/widgets/widget-1");
      await editorReady();
      await editMessage("Tacos today");
      await userEvent.click(
        screen.getByRole("button", { name: "Back to Widgets" }),
      );
      const dialog = await screen.findByRole("alertdialog");
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Discard changes" }),
      );
      await waitFor(() => expect(path()).toBe("/widgets"));
    });

    it("does not warn once a value is changed back", async () => {
      mockEditorApi({ asset: textWidget() });
      renderEditorRoute("/widgets/widget-1");
      await editorReady();
      await editMessage("Tacos today");
      expect(screen.getByText("Unsaved changes")).toBeTruthy();
      await editMessage("Pizza today");
      expect(screen.getByText("Saved")).toBeTruthy();
      await userEvent.click(
        screen.getByRole("button", { name: "Back to Widgets" }),
      );
      await waitFor(() => expect(path()).toBe("/widgets"));
    });

    it("discards from the actions menu without leaving", async () => {
      mockEditorApi({ asset: textWidget() });
      renderEditorRoute("/widgets/widget-1");
      await editorReady();
      const message = await editMessage("Tacos today");
      await userEvent.click(
        screen.getByRole("button", { name: "Widget actions" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", {
          name: /Discard unsaved changes/,
        }),
      );
      expect(message).toHaveValue("Pizza today");
      expect(path()).toBe("/widgets/widget-1");
      expect(screen.getByText("Saved")).toBeTruthy();
    });
  });

  describe("saving", () => {
    it("saves an existing Widget and makes the Server's result the baseline", async () => {
      mockEditorApi({ asset: textWidget() });
      const update = vi
        .spyOn(api, "updateWidget")
        .mockImplementation((_id, input) =>
          Promise.resolve(
            textWidget({
              name: input.name,
              widget: {
                provider: "text",
                configVersion: 1,
                // The Server normalizes colors to lowercase.
                configuration: {
                  ...(input.configuration as Record<string, unknown>),
                  body: "Tacos today",
                },
              },
            }),
          ),
        );
      renderEditorRoute("/widgets/widget-1");
      const save = await editorReady();
      expect(save).toBeDisabled();
      await editMessage("Tacos today");
      expect(save).toBeEnabled();
      await userEvent.click(save);
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      expect(update.mock.calls[0]![1]).toMatchObject({
        provider: "text",
        name: "Lunch Notice",
        configuration: { body: "Tacos today", heading: "Lunch" },
      });
      await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
      expect(save).toBeDisabled();
      // Nothing is left to protect, so leaving does not ask.
      await userEvent.click(
        screen.getByRole("button", { name: "Back to Widgets" }),
      );
      await waitFor(() => expect(path()).toBe("/widgets"));
    });

    it("keeps a failed save dirty and retries it", async () => {
      mockEditorApi({ asset: textWidget() });
      const update = vi
        .spyOn(api, "updateWidget")
        .mockRejectedValueOnce(
          new ApiError("Message is required", 400, "invalid_widget"),
        )
        .mockImplementation(() => Promise.resolve(textWidget()));
      renderEditorRoute("/widgets/widget-1");
      const save = await editorReady();
      await editMessage("Tacos today");
      await userEvent.click(save);
      expect(await screen.findByText("Message is required")).toBeTruthy();
      expect(screen.getAllByText("Save failed").length).toBeGreaterThan(0);
      expect(save).toBeEnabled();
      await userEvent.click(
        screen.getAllByRole("button", { name: "Retry" })[0]!,
      );
      await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    });

    it("saves with Ctrl+S or Command+S, and does nothing when clean", async () => {
      mockEditorApi({ asset: textWidget() });
      const update = vi
        .spyOn(api, "updateWidget")
        .mockResolvedValue(textWidget());
      renderEditorRoute("/widgets/widget-1");
      await editorReady();
      fireEvent.keyDown(window, { key: "s", ctrlKey: true });
      expect(update).not.toHaveBeenCalled();
      const message = await editMessage("Tacos today");
      fireEvent.keyDown(message, { key: "s", metaKey: true });
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    });

    it("does not submit an invalid draft and points at the problem", async () => {
      mockEditorApi({ asset: textWidget() });
      const update = vi.spyOn(api, "updateWidget");
      renderEditorRoute("/widgets/widget-1");
      const save = await editorReady();
      const message = await editMessage("");
      await userEvent.click(save);
      expect(update).not.toHaveBeenCalled();
      expect(await screen.findByText("Enter a value.")).toBeTruthy();
      expect(message).toHaveAttribute("aria-invalid", "true");
      await waitFor(() => expect(message).toHaveFocus());
      // Fixing the value lets Save run again.
      await editMessage("Tacos today");
      expect(save).toBeEnabled();
    });

    it("saves a valid Widget whose preview cannot render", async () => {
      mockEditorApi({ asset: textWidget() });
      const update = vi
        .spyOn(api, "updateWidget")
        .mockResolvedValue(textWidget());
      renderEditorRoute("/widgets/widget-1");
      const save = await editorReady();
      await editMessage("Tacos today");
      // The preview's state never gates persistence.
      await userEvent.click(save);
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    });
  });

  describe("creating", () => {
    it("opens the same editor with a useful draft name and defaults", async () => {
      mockEditorApi();
      renderEditorRoute("/widgets/new/text");
      await editorReady(/Save Widget/);
      expect(
        screen.getByRole("heading", { level: 1, name: /New Text/ }),
      ).toBeTruthy();
      expect(screen.getByText("Not saved yet")).toBeTruthy();
      expect(screen.getByRole("textbox", { name: /Message/ })).toHaveValue(
        "Write your announcement here.",
      );
    });

    it("replaces the route with the new Widget and keeps editing it", async () => {
      mockEditorApi();
      const created = textWidget({ id: "widget-9", name: "New Text" });
      const create = vi.spyOn(api, "createWidget").mockResolvedValue(created);
      vi.spyOn(api, "asset").mockResolvedValue(created);
      const { router } = renderEditorRoute("/widgets/new/text");
      await userEvent.click(await editorReady(/Save Widget/));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(path()).toBe("/widgets/widget-9"));
      expect(router.state.historyAction).toBe("REPLACE");
      expect(await editorReady()).toBeDisabled();
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("keeps the playlist handoff for a Widget created from a playlist", async () => {
      mockEditorApi();
      const created = textWidget({ id: "widget-9", name: "New Text" });
      vi.spyOn(api, "createWidget").mockResolvedValue(created);
      vi.spyOn(api, "asset").mockResolvedValue(created);
      renderEditorRoute("/widgets/new/text?returnTo=%2Fplaylists%2Fplaylist-1");
      await userEvent.click(await editorReady(/Save Widget/));
      await waitFor(() =>
        expect(path()).toBe(
          "/widgets/widget-9?returnTo=%2Fplaylists%2Fplaylist-1&created=1",
        ),
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "Back to Playlist" }),
      );
      await waitFor(() =>
        expect(path()).toBe("/playlists/playlist-1?newWidget=widget-9"),
      );
    });

    it("warns before leaving a new Widget only after it was edited", async () => {
      mockEditorApi();
      renderEditorRoute("/widgets/new/text");
      await editorReady(/Save Widget/);
      await editMessage("Tacos today");
      await userEvent.click(
        screen.getByRole("button", { name: "Back to Widgets" }),
      );
      expect(
        await screen.findByRole("alertdialog", {
          name: "Discard unsaved changes?",
        }),
      ).toBeTruthy();
    });
  });

  describe("details", () => {
    it("applies a new name to the draft without writing to the Server", async () => {
      mockEditorApi({ asset: textWidget() });
      const update = vi.spyOn(api, "updateWidget");
      renderEditorRoute("/widgets/widget-1");
      await editorReady();
      await userEvent.click(
        screen.getByRole("button", { name: "Widget actions" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: /Edit details/ }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "Widget details",
      });
      const name = within(dialog).getByRole("textbox", { name: "Name" });
      await userEvent.clear(name);
      await userEvent.type(name, "Cafeteria Notice");
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Apply" }),
      );
      expect(update).not.toHaveBeenCalled();
      expect(
        screen.getByRole("heading", { level: 1, name: /Cafeteria Notice/ }),
      ).toBeTruthy();
      expect(screen.getByText("Unsaved changes")).toBeTruthy();
    });
  });

  describe("impact and actions", () => {
    it("shows what the Widget is used by before saving", async () => {
      mockEditorApi({
        asset: textWidget({
          playlistUsage: 1,
          playlistsUsing: [{ id: "playlist-1", name: "Cafeteria loop" }],
          layoutUsage: [
            { id: "layout-1", name: "Lobby Board", published: true },
          ],
        }),
      });
      renderEditorRoute("/widgets/widget-1");
      await editorReady();
      await userEvent.click(screen.getByRole("button", { name: "Used by 2" }));
      const panel = await screen.findByRole("dialog", { name: "Used by" });
      expect(
        within(panel).getByRole("link", { name: /Cafeteria loop/ }),
      ).toHaveAttribute("href", "/playlists/playlist-1");
      expect(
        within(panel).getByRole("link", { name: /Lobby Board/ }),
      ).toHaveAttribute("href", "/layouts/layout-1");
      expect(within(panel).getByText("Published")).toBeTruthy();
    });

    it("refuses to delete a Widget that is in use", async () => {
      mockEditorApi({
        asset: textWidget({
          layoutUsage: [{ id: "layout-1", name: "Lobby", published: false }],
        }),
      });
      const remove = vi.spyOn(api, "deleteAsset");
      renderEditorRoute("/widgets/widget-1");
      await editorReady();
      await userEvent.click(
        screen.getByRole("button", { name: "Widget actions" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: /Delete Widget/ }),
      );
      const dialog = await screen.findByRole("alertdialog", {
        name: "Delete “Lunch Notice”?",
      });
      expect(dialog).toHaveTextContent(/used by 1 playlist or Layout/);
      expect(
        within(dialog).queryByRole("button", { name: "Delete Widget" }),
      ).toBeNull();
      expect(remove).not.toHaveBeenCalled();
    });

    it("deletes an unused Widget after confirmation", async () => {
      mockEditorApi({ asset: textWidget() });
      const remove = vi.spyOn(api, "deleteAsset").mockResolvedValue();
      renderEditorRoute("/widgets/widget-1");
      await editorReady();
      await editMessage("Tacos today");
      await userEvent.click(
        screen.getByRole("button", { name: "Widget actions" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: /Delete Widget/ }),
      );
      const dialog = await screen.findByRole("alertdialog");
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Delete Widget" }),
      );
      await waitFor(() =>
        expect(remove).toHaveBeenCalledWith("widget-1", "csrf"),
      );
      // Deleting is the decision; it does not also ask to discard.
      await waitFor(() => expect(path()).toBe("/widgets"));
    });
  });

  describe("viewers", () => {
    it("can inspect and preview but not change or save", async () => {
      mockEditorApi({ asset: textWidget(), role: "viewer" });
      renderEditorRoute("/widgets/widget-1");
      const message = await screen.findByRole(
        "textbox",
        { name: /Message/ },
        { timeout: 4000 },
      );
      expect(message).toBeDisabled();
      expect(screen.getByText("View only")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Save changes/ })).toBeNull();
      expect(
        screen.getByRole("combobox", { name: "Preview frame" }),
      ).toBeEnabled();
      await userEvent.click(
        screen.getByRole("button", { name: "Widget actions" }),
      );
      expect(
        await screen.findByRole("menuitem", { name: /View details/ }),
      ).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: /Duplicate/ })).toBeNull();
      expect(
        screen.queryByRole("menuitem", { name: /Delete Widget/ }),
      ).toBeNull();
    });
  });

  describe("problems", () => {
    it("says when a Widget does not exist", async () => {
      mockEditorApi();
      vi.spyOn(api, "asset").mockRejectedValue(
        new ApiError("Not found", 404, "not_found"),
      );
      renderEditorRoute("/widgets/missing");
      expect(await screen.findByText("Widget not found")).toBeTruthy();
    });

    it("says when a saved Widget's type is not installed", async () => {
      mockEditorApi({ asset: savedWidget("retired-plugin-widget", {}) });
      renderEditorRoute("/widgets/widget-1");
      expect(await screen.findByText("Widget type unavailable")).toBeTruthy();
      expect(
        screen.getByText(/Restore or update the plugin that provides it/),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    });

    it("never opens another editor for a provider that cannot describe itself", async () => {
      const catalog = repositoryCatalog();
      catalog.widgets.push({
        id: "componentless",
        version: 1,
        name: "Componentless",
        description: "A third-party type with no component.",
        category: "Essentials",
        icon: "box",
        runtime: "native",
        configurationSchema: {
          fields: [{ key: "text", label: "Text", control: "text" }],
        },
        defaultConfiguration: {},
        presentationSchemaVersion: 1,
        requiredCapabilities: {},
        emptyStateBehavior: "text",
      });
      mockEditorApi({
        catalog,
        asset: savedWidget("componentless", { text: "Hi" }),
      });
      renderEditorRoute("/widgets/widget-1");
      expect(await screen.findByText("Widget type unavailable")).toBeTruthy();
      expect(
        screen.getByText(
          "Componentless must be updated to support the current Widget authoring contract.",
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("textbox", { name: "Text" })).toBeNull();
    });

    it("shows a retired type's reason instead of an editor", async () => {
      mockEditorApi({ asset: savedWidget("notion", {}) });
      renderEditorRoute("/widgets/widget-1");
      expect(await screen.findByText("Widget type unavailable")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    });
  });
});
