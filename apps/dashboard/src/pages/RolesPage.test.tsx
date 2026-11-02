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
import type { CapabilityDefinition, Role } from "../api/types";
import { builtinCapabilities, mockAuthAs } from "../test/capabilities";
import { RolesPage } from "./RolesPage";

const definition = (
  key: string,
  group: CapabilityDefinition["group"],
  extra: Partial<CapabilityDefinition> = {},
): CapabilityDefinition => ({
  key,
  group,
  requires: [],
  ownerReserved: false,
  delegable: true,
  grantable: true,
  ...extra,
});

const catalog: CapabilityDefinition[] = [
  definition("media.read", "media"),
  definition("media.upload", "media", { requires: ["media.read"] }),
  definition("media.edit", "media", { requires: ["media.read"] }),
  definition("media.tags.assign", "media", { requires: ["media.read"] }),
  definition("playlist.read", "playlists"),
  definition("users.manage", "administration", {
    delegable: false,
    grantable: false,
  }),
];

const role = (key: string, extra: Partial<Role> = {}): Role => ({
  key,
  name: key[0]!.toUpperCase() + key.slice(1),
  description: "",
  builtin: true,
  capabilities: builtinCapabilities(key),
  userCount: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  editable: false,
  assignable: true,
  ...extra,
});

const classroom = role("classroom_media", {
  name: "Classroom Media",
  description: "Upload and tag media in assigned folders.",
  builtin: false,
  capabilities: ["media.read", "media.upload"],
  userCount: 2,
  editable: true,
});

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RolesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockAuthAs("administrator");
  vi.spyOn(api, "roles").mockResolvedValue([
    role("owner"),
    role("viewer"),
    classroom,
  ]);
  vi.spyOn(api, "capabilityCatalog").mockResolvedValue(catalog);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Roles", () => {
  it("lists built-in roles as fixed and custom roles as editable", async () => {
    renderPage();
    const custom = (await screen.findByText("Classroom Media")).closest(
      '[data-slot="item"]',
    ) as HTMLElement;
    expect(within(custom).getByText("Custom")).toBeInTheDocument();
    expect(within(custom).getByText(/2 people/)).toBeInTheDocument();
    expect(
      within(custom).getByRole("button", { name: "Edit" }),
    ).toBeInTheDocument();
    expect(
      within(custom).getByRole("button", { name: "Delete" }),
    ).toBeInTheDocument();

    const builtin = screen
      .getByText("Viewer")
      .closest('[data-slot="item"]') as HTMLElement;
    expect(within(builtin).getByText("Built-in")).toBeInTheDocument();
    // Built-in roles can be read and copied, never changed or removed.
    expect(
      within(builtin).getByRole("button", { name: "View" }),
    ).toBeInTheDocument();
    expect(within(builtin).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      within(builtin).queryByRole("button", { name: "Delete" }),
    ).toBeNull();
  });

  it("offers role creation only to an account that manages roles", async () => {
    mockAuthAs("editor");
    renderPage();
    await screen.findByText("Classroom Media");
    expect(screen.queryByRole("button", { name: "Create role" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Duplicate/ })).toBeNull();
  });

  it("creates the Classroom Media role with only the Media capabilities it needs", async () => {
    const create = vi
      .spyOn(api, "createRole")
      .mockResolvedValue(role("classroom_media_2", { builtin: false }));
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "Create role" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(
      within(dialog).getByLabelText("Name"),
      "Classroom Media",
    );
    // Applying tags needs viewing, so choosing it also turns viewing on.
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: /Apply tags/ }),
    );
    expect(
      within(dialog).getByRole("checkbox", { name: /View media/ }),
    ).toBeChecked();
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: /Upload media/ }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create role" }),
    );

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toEqual({
      name: "Classroom Media",
      description: "",
      capabilities: ["media.read", "media.tags.assign", "media.upload"],
    });
  });

  it("shows a capability the account cannot grant as locked with the reason", async () => {
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "Create role" }),
    );
    const dialog = await screen.findByRole("dialog");
    const manageUsers = within(dialog).getByRole("checkbox", {
      name: /Manage people/,
    });
    expect(manageUsers).toHaveAttribute("aria-disabled", "true");
    expect(
      within(dialog).getByText("Only an Owner can grant this."),
    ).toBeInTheDocument();
  });

  it("will not create a role with nothing selected", async () => {
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "Create role" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Empty role");
    expect(
      within(dialog).getByRole("button", { name: "Create role" }),
    ).toBeDisabled();
  });

  it("refuses to delete a role people still hold", async () => {
    const remove = vi.spyOn(api, "deleteRole").mockResolvedValue(undefined);
    renderPage();
    const custom = (await screen.findByText("Classroom Media")).closest(
      '[data-slot="item"]',
    ) as HTMLElement;
    await userEvent.click(
      within(custom).getByRole("button", { name: "Delete" }),
    );
    expect(
      await screen.findByText(/2 people still hold this role/),
    ).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });
});
