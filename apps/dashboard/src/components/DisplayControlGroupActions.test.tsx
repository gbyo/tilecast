// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/errors";
import { api } from "../api/client";
import type {
  DisplayControlGroupApplyResult,
  DisplayControlGroupPreview,
} from "../api/types";
import { i18n } from "../i18n";
import { DisplayControlGroupActions } from "./DisplayControlGroupActions";
import { toast } from "./ui/toast";

const preview: DisplayControlGroupPreview = {
  groupId: "group-1",
  groupName: "Lobby",
  commandType: "display_power_on",
  selectedCount: 1,
  supportedCount: 1,
  unsupportedCount: 0,
  eligibleCount: 1,
  fingerprint: "preview-fingerprint",
  screens: [],
};

const applyResult: DisplayControlGroupApplyResult = {
  groupId: "group-1",
  commandType: "display_power_on",
  selectedCount: 1,
  supportedCount: 1,
  queuedCount: 2,
  failedCount: 0,
  unsupportedCount: 0,
  results: [],
};

function renderActions() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DisplayControlGroupActions
        groupId="group-1"
        memberCount={1}
        manageable
        csrfToken="csrf"
      />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("DisplayControlGroupActions feedback", () => {
  it("opens a preview dialog for the chosen command", async () => {
    vi.spyOn(api, "displayControlGroupPreview").mockResolvedValue({
      ...preview,
      commandType: "display_power_off",
      selectedCount: 2,
      eligibleCount: 1,
      unsupportedCount: 1,
      screens: [
        {
          screenId: "a",
          name: "Cafeteria East",
          provider: "cec",
          capabilities: {},
          supported: true,
          eligible: true,
        },
        {
          screenId: "b",
          name: "Fire TV",
          provider: "none",
          capabilities: {},
          supported: false,
          eligible: false,
          reason: "DDC/CEC power unavailable",
        },
      ],
    });
    renderActions();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Power off" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Power off displays?" }),
    ).toBeTruthy();
    expect(await within(dialog).findByText("Cafeteria East")).toBeTruthy();
    expect(within(dialog).getByText("Supported")).toBeTruthy();
    expect(within(dialog).getByText("DDC/CEC power unavailable")).toBeTruthy();
    expect(
      within(dialog).getByText("2 selected · 1 can receive this command"),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Power off 1 display" }),
    ).toBeTruthy();
  });

  it("applies the command with the previewed fingerprint", async () => {
    vi.spyOn(api, "displayControlGroupPreview").mockResolvedValue(preview);
    const apply = vi
      .spyOn(api, "applyDisplayControlGroup")
      .mockResolvedValue(applyResult);
    renderActions();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Power on" }));
    await user.click(
      await screen.findByRole("button", { name: "Power on 1 display" }),
    );

    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith(
        "group-1",
        "display_power_on",
        "preview-fingerprint",
        "csrf",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not send when nothing can receive the command", async () => {
    vi.spyOn(api, "displayControlGroupPreview").mockResolvedValue({
      ...preview,
      eligibleCount: 0,
      supportedCount: 0,
      unsupportedCount: 1,
    });
    renderActions();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Mute" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        within(dialog)
          .getByRole("button", { name: "Mute 0 displays" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );
  });

  it("localizes preview API errors", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(api, "displayControlGroupPreview").mockRejectedValue(
      new ApiError("Too many requests from the server.", 429, "rate_limited"),
    );
    renderActions();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Включить" }));

    expect(
      await screen.findByText(
        "Слишком много попыток. Подождите немного и повторите попытку.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Too many requests from the server.")).toBeNull();
  });

  it("localizes apply API errors", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(api, "displayControlGroupPreview").mockResolvedValue(preview);
    vi.spyOn(api, "applyDisplayControlGroup").mockRejectedValue(
      new ApiError("Too many requests from the server.", 429, "rate_limited"),
    );
    renderActions();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Включить" }));
    await user.click(
      await screen.findByRole("button", { name: "Включить 1 дисплей" }),
    );

    expect(
      await screen.findByText(
        "Слишком много попыток. Подождите немного и повторите попытку.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Too many requests from the server.")).toBeNull();
  });

  it("uses the localized queued result in the success toast", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(api, "displayControlGroupPreview").mockResolvedValue(preview);
    vi.spyOn(api, "applyDisplayControlGroup").mockResolvedValue(applyResult);
    const addToast = vi.spyOn(toast, "add");
    const expectedMessage = i18n.t("groupctl.queued", {
      ns: "screens",
      count: applyResult.queuedCount,
      failed: "",
    });
    renderActions();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Включить" }));
    await user.click(
      await screen.findByRole("button", { name: "Включить 1 дисплей" }),
    );

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith({
        title: expectedMessage,
        type: "success",
      }),
    );
    expect(expectedMessage).not.toContain("queued");
  });
});
