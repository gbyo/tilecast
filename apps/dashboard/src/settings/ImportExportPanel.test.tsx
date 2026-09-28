// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportExportPanel } from "./SettingsOperations";
import { api } from "../api/client";
import "../i18n";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf", user: { role: "owner" } } }),
}));

const validDocument = {
  schemaVersion: 1,
  exportedAt: "2026-07-30T11:00:00Z",
  tilecastVersion: "1.0.0",
  organization: {
    schemaVersion: 1,
    revision: 4,
    values: { "branding.productName": "Library Signs" },
    updatedAt: "2026-07-30T11:00:00Z",
  },
  groupPolicies: [],
};

function file(contents: unknown, name: string) {
  const text =
    typeof contents === "string" ? contents : JSON.stringify(contents);
  return new File([text], name, { type: "application/json" });
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ImportExportPanel owner />
    </QueryClientProvider>,
  );
}

describe("Settings import", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not let an older valid file be applied after an invalid one is chosen", async () => {
    const user = userEvent.setup();
    const preview = vi.spyOn(api, "previewSettingsImport").mockResolvedValue({
      valid: true,
      changedKeys: ["branding.productName"],
      groupPolicyCount: 0,
      screenPolicyCount: 0,
      requiresConfirmation: true,
    });
    const apply = vi.spyOn(api, "applySettingsImport");
    renderPanel();

    const input = screen.getByLabelText(/settings file/i, {
      selector: "input",
    });
    await user.upload(input, file(validDocument, "valid.json"));
    await user.click(screen.getByRole("button", { name: /validate/i }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole("button", { name: /apply/i }),
    ).toBeInTheDocument();

    await user.upload(input, file({ schemaVersion: 2 }, "future.json"));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /apply/i }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /validate/i })).toBeDisabled();
    expect((input as HTMLInputElement).value).toBe("");
    expect(apply).not.toHaveBeenCalled();
  });

  it("treats a file that is not JSON as invalid and clears the earlier one", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "previewSettingsImport").mockResolvedValue({
      valid: true,
      changedKeys: [],
      groupPolicyCount: 0,
      screenPolicyCount: 0,
      requiresConfirmation: false,
    });
    renderPanel();

    const input = screen.getByLabelText(/settings file/i, {
      selector: "input",
    });
    await user.upload(input, file(validDocument, "valid.json"));
    expect(screen.getByRole("button", { name: /validate/i })).toBeEnabled();

    await user.upload(input, file("not json", "broken.json"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /validate/i })).toBeDisabled(),
    );
  });
});
