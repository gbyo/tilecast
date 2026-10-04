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
import { api } from "../api/client";
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
    const row = name.closest<HTMLElement>('[data-slot="item"]');
    expect(row).not.toBeNull();
    expect(
      row!.querySelector('[data-slot="avatar-fallback"]'),
    ).toHaveTextContent("FE");
    await userEvent.click(within(row!).getByRole("button", { name: "Edit" }));
    const editDialog = document.body.querySelector<HTMLElement>(
      '[data-slot="dialog-content"]',
    );
    expect(editDialog).toHaveClass(
      "max-h-[calc(100dvh-2rem)]",
      "overflow-y-auto",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete permanently" }),
    );

    await waitFor(() => {
      // The typed transport prefixes the origin (see studioFetch in
      // ../api/transport.ts); match the dedicated endpoint by path.
      const deletion = request.mock.calls.find(
        ([input, init]) =>
          typeof input === "string" &&
          input.endsWith("/api/v1/users/user-2/permanent") &&
          init?.method === "DELETE",
      );
      expect(deletion).toBeDefined();
      expect(new Headers(deletion?.[1]?.headers).get("X-CSRF-Token")).toBe(
        "csrf-token",
      );
    });
  });
});

describe("user editor screen scope disclosure", () => {
  it("keeps screen scope collapsed until requested", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: "user-2",
                  name: "Dana Editor",
                  username: "dana-editor",
                  role: "editor",
                  active: true,
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
      ),
    );
    vi.spyOn(api, "userScreenScopes").mockResolvedValue({
      scopes: [],
      wholeFleet: true,
    });
    vi.spyOn(api, "locations").mockResolvedValue({
      items: [{ id: "loc-1", name: "Library" }],
    } as never);
    vi.spyOn(api, "screenGroups").mockResolvedValue({ items: [] } as never);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <UsersPage />
      </QueryClientProvider>,
    );

    const name = await screen.findByText("Dana Editor");
    const row = name.closest<HTMLElement>('[data-slot="item"]');
    await userEvent.click(within(row!).getByRole("button", { name: "Edit" }));

    const trigger = await screen.findByRole("button", {
      name: "Screen scope",
    });
    expect(
      screen.queryByRole("button", { name: "Save screen scope" }),
    ).toBeNull();

    await userEvent.click(trigger);
    // The scope editor opens on the explicit access choice; location
    // checkboxes appear once limited access is selected.
    await userEvent.click(
      await screen.findByRole("radio", { name: "Limit access" }),
    );
    expect(
      await screen.findByRole("checkbox", { name: "Library" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save screen scope" }),
    ).toBeInTheDocument();
  });
});

describe("user creation dialog", () => {
  it("opens the creation form behind the Add user action and submits it", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        if (
          typeof input === "string" &&
          input.endsWith("/api/v1/users") &&
          init?.method === "POST"
        ) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  id: "user-3",
                  name: "New Editor",
                  username: "new-editor",
                  role: "editor",
                  active: true,
                  createdAt: "2026-01-01T00:00:00Z",
                },
              }),
              {
                status: 201,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                items: [
                  {
                    id: "user-2",
                    name: "Dana Editor",
                    username: "dana-editor",
                    role: "editor",
                    active: true,
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

    await screen.findByText("Dana Editor");
    expect(
      screen.queryByLabelText("Temporary password"),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add user" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a user" });
    const submit = within(dialog).getByRole("button", { name: "Add user" });
    expect(submit).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText("Name"), "New Editor");
    await userEvent.type(
      within(dialog).getByLabelText("Username"),
      "new-editor",
    );
    await userEvent.type(
      within(dialog).getByLabelText("Temporary password"),
      "a-very-long-password",
    );
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    await waitFor(() => {
      const creation = request.mock.calls.find(
        ([input, init]) =>
          typeof input === "string" &&
          input.endsWith("/api/v1/users") &&
          init?.method === "POST",
      );
      expect(creation).toBeDefined();
      expect(JSON.parse(creation?.[1]?.body as string)).toMatchObject({
        name: "New Editor",
        username: "new-editor",
        role: "viewer",
      });
    });
    await waitFor(() =>
      expect(screen.queryByLabelText("Temporary password")).toBeNull(),
    );
  });
});
