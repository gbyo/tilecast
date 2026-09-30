// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { apiErrorMessage, i18n } from "../i18n";
import { SystemPanel } from "./SettingsOperations";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf-token" } }),
}));

vi.mock("../components/ConfirmDialog", () => ({
  useConfirm: () => ({ confirm: vi.fn(), dialog: null }),
}));

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SystemPanel canManage />
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("SystemPanel API errors", () => {
  it("localizes diagnostics and maintenance failures through the shared API error helper", async () => {
    await i18n.changeLanguage("ru");
    const failure = Object.assign(new Error("Raw server response"), {
      code: "rate_limited",
    });
    vi.spyOn(api, "systemStatus").mockRejectedValue(failure);
    vi.spyOn(api, "runMaintenance").mockRejectedValue(failure);

    const user = userEvent.setup();
    renderPanel();

    const localizedError = apiErrorMessage(failure);
    expect(localizedError).not.toBe(failure.message);
    const diagnosticContext = i18n.t("operations.system.diagnosticsError", {
      ns: "settings",
      error: localizedError,
    });
    expect(await screen.findByText(diagnosticContext)).toBeInTheDocument();

    const runLabel = i18n.t("operations.system.run", { ns: "settings" });
    await user.click(screen.getAllByRole("button", { name: runLabel })[3]!);

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    const alerts = screen.getAllByRole("alert");
    expect(alerts[0]).toHaveTextContent(diagnosticContext);
    expect(alerts[1]).toHaveTextContent(localizedError);
    expect(screen.queryByText(failure.message)).not.toBeInTheDocument();
  });
});
