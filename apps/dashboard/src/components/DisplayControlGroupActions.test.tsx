// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  it("localizes preview API errors", async () => {
    await i18n.changeLanguage("ru");
    vi.spyOn(api, "displayControlGroupPreview").mockRejectedValue(
      new ApiError("Too many requests from the server.", 429, "rate_limited"),
    );
    renderActions();

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
    await user.click(
      await screen.findByRole("button", {
        name: "Отправить поддерживаемым экранам",
      }),
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
    await user.click(
      await screen.findByRole("button", {
        name: "Отправить поддерживаемым экранам",
      }),
    );

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith({
        title: expectedMessage,
        type: "success",
      }),
    );
    expect(await screen.findByText(expectedMessage)).toBeTruthy();
    expect(expectedMessage).not.toContain("queued");
  });
});
