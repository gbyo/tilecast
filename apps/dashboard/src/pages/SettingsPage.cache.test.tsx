// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { api } from "../api/client";
import { settingsQueries } from "../data/settings";
import { SidebarProvider } from "../components/ui/sidebar";
import type { SettingDefinition } from "../api/types";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf", user: { id: "owner", role: "owner" } },
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function SharedSettingsConsumer() {
  const settings = useQuery(settingsQueries.organization());
  const name = settings.data?.values["organization.name"];
  return (
    <output aria-label="Shared organization name">
      {typeof name === "string" ? name : ""}
    </output>
  );
}

it("publishes a successful organization save to other mounted consumers", async () => {
  const definition: SettingDefinition = {
    key: "organization.name",
    category: "general",
    type: "string",
    title: "Organization name",
    default: "",
    scope: "organization",
    sensitive: false,
    restartRequired: false,
    immediate: true,
    futureOnly: false,
  };
  const initial = {
    schemaVersion: 1,
    revision: 1,
    values: { "organization.name": "Old school" },
    definitions: [definition],
    updatedAt: "2026-10-02T12:00:00Z",
  };
  const saved = {
    ...initial,
    revision: 2,
    values: { "organization.name": "New school" },
  };
  const load = vi.spyOn(api, "settings").mockResolvedValue(initial);
  const save = vi.spyOn(api, "updateSettings").mockResolvedValue(saved);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        path: "/settings/general",
        element: (
          <>
            <SettingsPage />
            <SharedSettingsConsumer />
          </>
        ),
      },
    ],
    { initialEntries: ["/settings/general"] },
  );
  try {
    render(
      <QueryClientProvider client={client}>
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const input = await screen.findByRole("textbox", {
      name: "Organization name",
    });
    await user.clear(input);
    await user.type(input, "New school");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText("New school", { selector: "output" }),
    ).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(
      1,
      { "organization.name": "New school" },
      "csrf",
    );
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    cleanup();
    client.clear();
  }
});
