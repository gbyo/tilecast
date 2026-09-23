// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsersPage } from "./UsersPage";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf-token",
      user: {
        id: "owner-1",
        name: "Owner",
        username: "owner",
        role: "owner",
        active: true,
        createdAt: "2026-01-01T00:00:00Z",
      },
    },
  }),
}));

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("permanent user deletion", () => {
  it("offers permanent deletion for an inactive account and calls the dedicated endpoint", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_input, init) => {
        if (init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                items: [
                  {
                    id: "user-2",
                    name: "Former Editor",
                    username: "former-editor",
                    role: "editor",
                    active: false,
                    createdAt: "2026-01-01T00:00:00Z",
                    mfaEnrolled: false,
                    mfaRequired: false,
                  },
                ],
                total: 1,
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <UsersPage />
      </QueryClientProvider>,
    );

    const name = await screen.findByText("Former Editor");
    const row = name.closest("article");
    expect(row).not.toBeNull();
    await userEvent.click(within(row!).getByRole("button", { name: "Edit" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete permanently" }),
    );

    await waitFor(() => {
      const deletion = request.mock.calls.find(
        ([input, init]) =>
          typeof input === "string" &&
          input === "/api/v1/users/user-2/permanent" &&
          init?.method === "DELETE",
      );
      expect(deletion).toBeDefined();
      expect(new Headers(deletion?.[1]?.headers).get("X-CSRF-Token")).toBe(
        "csrf-token",
      );
    });
  });
});
