// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlayerPolicyEditor } from "./PlayerPolicyEditor";
import { api } from "../api/client";
import { i18n } from "../i18n";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf", user: { role: "owner" } } }),
}));

const definition = {
  key: "player.playback.autoplay",
  category: "player",
  type: "bool",
  title: "Autoplay",
  default: false,
  scope: "policy",
  sensitive: false,
  restartRequired: false,
  immediate: false,
  futureOnly: false,
} as const;

function renderEditor() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PlayerPolicyEditor target="group" id="g1" />
    </QueryClientProvider>,
  );
}

describe("PlayerPolicyEditor action bar", () => {
  beforeEach(() => {
    vi.spyOn(api, "settings").mockResolvedValue({
      schemaVersion: 1,
      revision: 1,
      definitions: [definition],
      values: {},
      updatedAt: "2026-03-04T12:00:00Z",
    });
    vi.spyOn(api, "groupPolicy").mockResolvedValue({
      schemaVersion: 1,
      revision: 1,
      priority: 0,
      values: { "player.playback.autoplay": false },
    });
  });
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await i18n.changeLanguage("en");
  });

  it("hides the action bar while clean", async () => {
    renderEditor();
    expect(
      await screen.findByRole("switch", { name: "Autoplay" }),
    ).toBeTruthy();
    expect(screen.queryByText("Unsaved player-setting changes")).toBeNull();
  });

  it("pins a sticky action bar with cancel and save once dirty", async () => {
    renderEditor();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Autoplay" }));
    const notice = await screen.findByText("Unsaved player-setting changes");
    const bar = notice.parentElement;
    expect(bar?.className).toContain("sticky");
    expect(bar?.className).toContain("bottom-0");
    const actions = within(bar as HTMLElement);
    expect(actions.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(actions.getByRole("button", { name: "Save changes" })).toBeTruthy();
  });
});
