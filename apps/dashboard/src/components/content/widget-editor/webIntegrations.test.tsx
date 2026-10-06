// @vitest-environment jsdom
// Website and YouTube author in the one Widget editor. Their definitions
// describe every setting their old editors offered, and saving sends what
// the Server's Website and YouTube validation already accepts.
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
import { i18n } from "@/i18n";
import enDefinitions from "@/locales/en/definitions.json";
import esDefinitions from "@/locales/es/definitions.json";
import ruDefinitions from "@/locales/ru/definitions.json";
import { youtubePreviewIds } from "./preview/webPreviewConfiguration";
import {
  mockEditorApi,
  renderEditorRoute,
  savedWidget,
  useViewport,
} from "./testing";

beforeEach(() => useViewport("tablet"));
afterEach(() => {
  void i18n.changeLanguage("en");
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const website = {
  url: "https://example.com/menu",
  displayUrl: "https://example.com/menu",
  allowedHosts: ["cdn.example.com", "example.com"],
  javascriptEnabled: false,
  domStorageEnabled: true,
  cookiePolicy: "disabled",
  reloadPolicy: "interval",
  refreshIntervalSeconds: 600,
  loadTimeoutSeconds: 45,
  zoomPercent: 125,
  scrollX: 10,
  scrollY: 240,
  customUserAgent: "Signage/1.0",
  backgroundColor: "#13231e",
  failureBehavior: "last_success",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const youtube = {
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  kind: "video",
  videoId: "dQw4w9WgXcQ",
  startSeconds: 15,
  endSeconds: 90,
  loop: true,
  muted: false,
  volume: 60,
  captions: true,
  captionLanguage: "es",
  controls: false,
  failureBehavior: "fallback_image",
  fallbackImageAssetId: "image-1",
  playlistPlaybackMode: "fixed_duration",
  fixedDurationSeconds: 45,
};

async function openSaved(
  provider: string,
  configuration: object,
  before?: () => void,
) {
  mockEditorApi({
    asset: savedWidget(provider, configuration as Record<string, unknown>),
  });
  before?.();
  vi.spyOn(api, "asset").mockImplementation((id) =>
    Promise.resolve(
      id === "image-1"
        ? savedWidget(
            "image",
            {},
            { id: "image-1", name: "Cafeteria fallback.png", type: "image" },
          )
        : savedWidget(provider, configuration as Record<string, unknown>),
    ),
  );
  renderEditorRoute("/widgets/widget-1");
  return screen.findByRole(
    "button",
    { name: /Save changes/ },
    { timeout: 4000 },
  );
}

async function tab(name: string) {
  const trigger = screen.getByRole("tab", { name });
  await userEvent.click(trigger);
  // A panel that is leaving can linger for a frame; take the tab's own.
  return document.getElementById(trigger.getAttribute("aria-controls")!)!;
}

async function choose(panel: HTMLElement, label: string, option: string) {
  await userEvent.click(within(panel).getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Website", () => {
  it("shows every saved setting in the editor", async () => {
    await openSaved("website", website);
    expect(
      screen.getAllByRole("tab").map((entry) => entry.textContent),
    ).toEqual(["Content", "Style", "Behavior"]);
    let panel = await tab("Content");
    expect(
      within(panel).getByRole("textbox", { name: /Web address/ }),
    ).toHaveValue("https://example.com/menu");
    panel = await tab("Style");
    expect(
      within(panel).getByRole("textbox", { name: "Background color" }),
    ).toHaveValue("#13231e");
    expect(
      within(panel).getByRole("spinbutton", { name: "Zoom (%)" }),
    ).toHaveValue(125);
    expect(
      within(panel).getByRole("spinbutton", { name: "Horizontal scroll (px)" }),
    ).toHaveValue(10);
    expect(
      within(panel).getByRole("spinbutton", { name: "Vertical scroll (px)" }),
    ).toHaveValue(240);
    panel = await tab("Behavior");
    expect(
      within(panel).getByRole("combobox", { name: "Reload" }),
    ).toHaveTextContent("Reload on an interval");
    expect(
      within(panel).getByRole("spinbutton", { name: "Reload every (seconds)" }),
    ).toHaveValue(600);
    expect(
      within(panel).getByRole("combobox", { name: "If the page cannot load" }),
    ).toHaveTextContent("Keep the last page that loaded");
    await userEvent.click(
      within(panel).getByRole("button", { name: "Advanced" }),
    );
    expect(
      within(panel).getByRole("spinbutton", { name: "Load timeout (seconds)" }),
    ).toHaveValue(45);
    expect(
      within(panel).getByRole("textbox", { name: "Allowed hosts 1" }),
    ).toHaveValue("cdn.example.com");
    expect(
      within(panel).getByRole("switch", { name: "Run JavaScript" }),
    ).not.toBeChecked();
    expect(
      within(panel).getByRole("switch", { name: "Allow DOM storage" }),
    ).toBeChecked();
    expect(
      within(panel).getByRole("combobox", { name: "Cookies" }),
    ).toHaveTextContent("Disabled");
    expect(
      within(panel).getByRole("textbox", { name: "Custom user agent" }),
    ).toHaveValue("Signage/1.0");
  });

  it("shows the reload interval and fallback image only when they apply", async () => {
    await openSaved("website", website);
    const panel = await tab("Behavior");
    await choose(panel, "Reload", "Load once while active");
    expect(
      within(panel).queryByRole("spinbutton", {
        name: "Reload every (seconds)",
      }),
    ).toBeNull();
    expect(within(panel).queryByText("Fallback image")).toBeNull();
    await choose(panel, "If the page cannot load", "Show a fallback image");
    expect(within(panel).getByText("Fallback image")).toBeTruthy();
  });

  it("saves only the settings the Server's Website validation accepts", async () => {
    const save = await openSaved("website", website);
    const update = vi
      .spyOn(api, "updateWidget")
      .mockResolvedValue(savedWidget("website", website));
    const panel = await tab("Style");
    fireEvent.change(
      within(panel).getByRole("spinbutton", { name: "Zoom (%)" }),
      {
        target: { value: "150" },
      },
    );
    await userEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1]).toEqual({
      provider: "website",
      name: "Lunch Countdown",
      description: "",
      configuration: {
        url: "https://example.com/menu",
        allowedHosts: ["cdn.example.com", "example.com"],
        javascriptEnabled: false,
        domStorageEnabled: true,
        cookiePolicy: "disabled",
        reloadPolicy: "interval",
        refreshIntervalSeconds: 600,
        loadTimeoutSeconds: 45,
        zoomPercent: 150,
        scrollX: 10,
        scrollY: 240,
        customUserAgent: "Signage/1.0",
        backgroundColor: "#13231e",
        failureBehavior: "last_success",
      },
    });
  });

  it("creates with the same defaults the old Website editor sent", async () => {
    mockEditorApi();
    const create = vi
      .spyOn(api, "createWidget")
      .mockResolvedValue(savedWidget("website", website, { id: "widget-9" }));
    renderEditorRoute("/widgets/new/website");
    const save = await screen.findByRole(
      "button",
      { name: /Save Widget/ },
      { timeout: 4000 },
    );
    await userEvent.click(save);
    expect(create).not.toHaveBeenCalled();
    const address = screen.getByRole("textbox", { name: /Web address/ });
    expect(address).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(address, { target: { value: "https://example.com" } });
    await userEvent.click(save);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0].configuration).toEqual({
      url: "https://example.com",
      allowedHosts: [],
      javascriptEnabled: true,
      domStorageEnabled: true,
      cookiePolicy: "first_party",
      reloadPolicy: "on_each_activation",
      refreshIntervalSeconds: 300,
      loadTimeoutSeconds: 20,
      zoomPercent: 100,
      scrollX: 0,
      scrollY: 0,
      customUserAgent: "",
      backgroundColor: "#0E141B",
      failureBehavior: "placeholder",
    });
  });

  it("previews the page in a sandboxed frame compiled from the draft", async () => {
    await openSaved("website", website, () =>
      vi.mocked(api.compileWidgetPreview).mockResolvedValue({
        schemaVersion: 1,
        kind: "web",
        requiredCapabilities: {},
        web: { url: "https://example.com/menu" },
      } as never),
    );
    const compile = vi.mocked(api.compileWidgetPreview);
    await waitFor(() => expect(compile).toHaveBeenCalled(), { timeout: 2000 });
    expect(compile.mock.calls[0]![0]).toBe("website");
    const frame = await screen.findByTitle("Web Widget preview");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  });

  it("reports player diagnostics from the actions menu", async () => {
    await openSaved("website", website);
    vi.spyOn(api, "websiteDiagnostics").mockResolvedValue({
      assetId: "widget-1",
      configuredUrl: "https://example.com/menu",
      allowedHosts: ["example.com"],
      lastFailureCategory: "timeout",
      reportingScreens: [{ id: "s1", name: "Lobby", state: "loaded" }],
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Widget actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Diagnostics" }),
    );
    const panel = await screen.findByRole("dialog", { name: "Diagnostics" });
    expect(await within(panel).findByText("timeout")).toBeTruthy();
    expect(within(panel).getByText("Lobby (loaded)")).toBeTruthy();
  });
});

describe("YouTube", () => {
  it("shows every saved setting and only the settings that apply", async () => {
    await openSaved("youtube", youtube);
    expect(
      screen.getAllByRole("tab").map((entry) => entry.textContent),
    ).toEqual(["Content", "Behavior"]);
    let panel = await tab("Content");
    expect(
      within(panel).getByRole("textbox", {
        name: /YouTube video or playlist URL/,
      }),
    ).toHaveValue(youtube.url);
    expect(
      within(panel).getByRole("spinbutton", { name: "Start at (seconds)" }),
    ).toHaveValue(15);
    expect(
      within(panel).getByRole("spinbutton", { name: "End at (seconds)" }),
    ).toHaveValue(90);
    expect(
      within(panel).getByRole("textbox", { name: "Caption language" }),
    ).toHaveValue("es");
    await userEvent.click(
      within(panel).getByRole("switch", { name: "Show captions" }),
    );
    expect(
      within(panel).queryByRole("textbox", { name: "Caption language" }),
    ).toBeNull();
    panel = await tab("Behavior");
    expect(
      within(panel).getByRole("spinbutton", { name: "Volume (%)" }),
    ).toHaveValue(60);
    await userEvent.click(
      within(panel).getByRole("switch", { name: "Mute audio" }),
    );
    expect(
      within(panel).queryByRole("spinbutton", { name: "Volume (%)" }),
    ).toBeNull();
    expect(
      within(panel).getByRole("switch", { name: "Loop playback" }),
    ).toBeChecked();
    expect(
      within(panel).getByRole("switch", { name: "Show YouTube controls" }),
    ).not.toBeChecked();
    expect(
      within(panel).getByRole("spinbutton", {
        name: "Fixed duration (seconds)",
      }),
    ).toHaveValue(45);
    expect(
      await within(panel).findByText("Cafeteria fallback.png"),
    ).toBeTruthy();
    await choose(panel, "Playlist item length", "Play until the video ends");
    expect(
      within(panel).queryByRole("spinbutton", {
        name: "Fixed duration (seconds)",
      }),
    ).toBeNull();
  });

  it("saves without the ids the Server derives from the URL", async () => {
    const save = await openSaved("youtube", youtube);
    const update = vi
      .spyOn(api, "updateWidget")
      .mockResolvedValue(savedWidget("youtube", youtube));
    const panel = await tab("Content");
    fireEvent.change(
      within(panel).getByRole("spinbutton", { name: "Start at (seconds)" }),
      {
        target: { value: "20" },
      },
    );
    await userEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1].configuration).toEqual({
      url: youtube.url,
      startSeconds: 20,
      endSeconds: 90,
      loop: true,
      muted: false,
      volume: 60,
      captions: true,
      captionLanguage: "es",
      controls: false,
      failureBehavior: "fallback_image",
      fallbackImageAssetId: "image-1",
      playlistPlaybackMode: "fixed_duration",
      fixedDurationSeconds: 45,
    });
  });

  it("removes the fallback image instead of sending an empty id", async () => {
    const save = await openSaved("youtube", youtube);
    const update = vi
      .spyOn(api, "updateWidget")
      .mockResolvedValue(savedWidget("youtube", youtube));
    const panel = await tab("Behavior");
    await userEvent.click(
      await within(panel).findByRole("button", {
        name: "Remove Fallback image",
      }),
    );
    await choose(
      panel,
      "If the video cannot play",
      "Show the Tilecast placeholder",
    );
    await userEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1].configuration).not.toHaveProperty(
      "fallbackImageAssetId",
    );
  });

  it("previews the edited address, not the ids from the last save", () => {
    expect(youtubePreviewIds("https://youtu.be/abcdefghijk")).toEqual({
      videoId: "abcdefghijk",
    });
    expect(
      youtubePreviewIds("https://www.youtube.com/playlist?list=PL1234567890"),
    ).toEqual({ playlistId: "PL1234567890" });
    expect(
      youtubePreviewIds("https://example.com/watch?v=abcdefghijk"),
    ).toEqual({});
  });
});

// Authoring text comes from the definition's translation keys, resolved by
// the one generic inspector. There is no Website or YouTube editor to
// translate separately.
describe.each([
  ["en", enDefinitions],
  ["es", esDefinitions],
  ["ru", ruDefinitions],
] as const)("authoring text in %s", (language, words) => {
  const accessibleName = (text: string) =>
    new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  it("localizes the Website settings, help text, and choices", async () => {
    await i18n.changeLanguage(language);
    mockEditorApi({ asset: savedWidget("website", website) });
    renderEditorRoute("/widgets/widget-1");
    const fields = words.website.fields;
    const tabs = await screen.findAllByRole("tab");
    let panel = await tab(tabs[0]!.textContent);
    expect(
      within(panel).getByRole("textbox", {
        name: accessibleName(fields.url.label),
      }),
    ).toHaveValue(website.url);
    expect(within(panel).getByText(fields.url.description)).toBeTruthy();
    panel = await tab(tabs[1]!.textContent);
    expect(
      within(panel).getByRole("spinbutton", {
        name: accessibleName(fields.zoomPercent.label),
      }),
    ).toHaveValue(125);
    panel = await tab(tabs[2]!.textContent);
    expect(
      within(panel).getByRole("combobox", {
        name: accessibleName(fields.reloadPolicy.label),
      }),
    ).toHaveTextContent(fields.reloadPolicy.options.interval);
    expect(
      within(panel).getByRole("spinbutton", {
        name: accessibleName(fields.refreshIntervalSeconds.label),
      }),
    ).toHaveValue(600);
    expect(
      within(panel).getByRole("combobox", {
        name: accessibleName(fields.failureBehavior.label),
      }),
    ).toHaveTextContent(fields.failureBehavior.options.last_success);
    await userEvent.click(
      within(panel).getByRole("button", {
        name: /Advanced|Avanzado|Дополнительно/,
      }),
    );
    for (const key of [
      "loadTimeoutSeconds",
      "javascriptEnabled",
      "domStorageEnabled",
      "customUserAgent",
    ] as const)
      expect(
        within(panel).getByRole(
          key === "loadTimeoutSeconds"
            ? "spinbutton"
            : key === "customUserAgent"
              ? "textbox"
              : "switch",
          { name: accessibleName(fields[key].label) },
        ),
        key,
      ).toBeTruthy();
    expect(
      within(panel).getByRole("combobox", {
        name: accessibleName(fields.cookiePolicy.label),
      }),
    ).toHaveTextContent(fields.cookiePolicy.options.disabled);
    expect(
      within(panel).getByText(fields.customUserAgent.description),
    ).toBeTruthy();
  });

  it("localizes the YouTube settings, help text, and choices", async () => {
    await i18n.changeLanguage(language);
    mockEditorApi({ asset: savedWidget("youtube", youtube) });
    renderEditorRoute("/widgets/widget-1");
    const fields = words.youtube.fields;
    const tabs = await screen.findAllByRole("tab");
    let panel = await tab(tabs[0]!.textContent);
    expect(
      within(panel).getByRole("textbox", {
        name: accessibleName(fields.url.label),
      }),
    ).toHaveValue(youtube.url);
    expect(within(panel).getByText(fields.url.description)).toBeTruthy();
    for (const key of ["startSeconds", "endSeconds"] as const)
      expect(
        within(panel).getByRole("spinbutton", {
          name: accessibleName(fields[key].label),
        }),
      ).toBeTruthy();
    expect(
      within(panel).getByRole("switch", {
        name: accessibleName(fields.captions.label),
      }),
    ).toBeChecked();
    expect(
      within(panel).getByRole("textbox", {
        name: accessibleName(fields.captionLanguage.label),
      }),
    ).toHaveValue("es");
    panel = await tab(tabs[1]!.textContent);
    expect(
      within(panel).getByRole("spinbutton", {
        name: accessibleName(fields.volume.label),
      }),
    ).toHaveValue(60);
    for (const key of ["loop", "controls", "muted"] as const)
      expect(
        within(panel).getByRole("switch", {
          name: accessibleName(fields[key].label),
        }),
      ).toBeTruthy();
    expect(
      within(panel).getByRole("combobox", {
        name: accessibleName(fields.playlistPlaybackMode.label),
      }),
    ).toHaveTextContent(fields.playlistPlaybackMode.options.fixed_duration);
    expect(
      within(panel).getByRole("spinbutton", {
        name: accessibleName(fields.fixedDurationSeconds.label),
      }),
    ).toHaveValue(45);
    expect(
      within(panel).getByRole("combobox", {
        name: accessibleName(fields.failureBehavior.label),
      }),
    ).toHaveTextContent(fields.failureBehavior.options.fallback_image);
  });
});
