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
import { i18n } from "../i18n";
import { UsersPage } from "./UsersPage";
import { builtinCapabilities, builtinMyAccess } from "../test/capabilities";

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
      capabilities: builtinCapabilities("owner"),
    },
  }),
}));

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify({ data }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const builtinRoleKeys = [
  "owner",
  "administrator",
  "editor",
  "contributor",
  "viewer",
];

const roleList = builtinRoleKeys.map((key) => ({
  key,
  name: key[0]!.toUpperCase() + key.slice(1),
  description: "",
  builtin: true,
  capabilities: builtinCapabilities(key),
  userCount: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  editable: false,
  assignable: key !== "owner",
}));

const contentFolders = [
  {
    id: "folder-313",
    name: "Room 313",
    description: "",
    assetCount: 4,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "folder-314",
    name: "Room 314",
    description: "",
    assetCount: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

const contentTags = [
  {
    id: "tag-signage",
    name: "Room 313 Signage",
    color: "#3b82f6",
    assetCount: 3,
  },
  { id: "tag-staff", name: "Staff Notices", color: "#dc2626", assetCount: 5 },
];

const classroomRole = {
  key: "classroom_media",
  name: "Classroom Media",
  description: "Upload and tag media in assigned folders.",
  builtin: false,
  capabilities: [
    "media.read",
    "media.upload",
    "media.edit",
    "media.tags.assign",
  ],
  userCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  editable: true,
  assignable: true,
};

const teacherRow = {
  id: "user-2",
  name: "Dana Teacher",
  username: "dana-teacher",
  role: "viewer",
  active: true,
  createdAt: "2026-01-01T00:00:00Z",
  mfaEnrolled: false,
  mfaRequired: false,
};

/**
 * Answer the requests the Users page makes by path: the account list, the
 * role catalog, the signed-in account's own access, and one account's
 * content access. `handle` sees a request first and may answer it.
 */
function mockUsersApi(
  users: Record<string, unknown>[],
  handle?: (path: string, init?: RequestInit) => Promise<Response> | undefined,
  roles: typeof roleList = roleList,
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const path = new URL(requestUrl(input), "http://studio.test").pathname;
    const custom = handle?.(path, init);
    if (custom) return custom;
    if (path === "/api/v1/roles") return json({ items: roles });
    if (path === "/api/v1/roles/capabilities") return json({ items: [] });
    if (path === "/api/v1/content-folders") return json(contentFolders);
    if (path === "/api/v1/content-tags") return json(contentTags);
    if (path === "/api/v1/me/access") return json(builtinMyAccess("owner"));
    if (/^\/api\/v1\/users\/[^/]+\/content-access$/.test(path)) {
      return json({
        policy: {
          libraryMode: "all",
          tagMode: "all",
          folders: [],
          tags: [],
          configured: true,
        },
        ownerUnrestricted: false,
      });
    }
    return json({ items: users, total: users.length });
  });
}

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
    const request = mockUsersApi(
      [
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
      (_path, init) =>
        init?.method === "DELETE"
          ? Promise.resolve(new Response(null, { status: 204 }))
          : undefined,
    );
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
  it("keeps screen access in its own tab until requested", async () => {
    mockUsersApi([
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
    ]);
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

    // The editor groups what a person can do (Role), which media they reach
    // (Content access), and which screens they reach (Screen access). Screen
    // access stays out of the way until its tab is opened.
    expect(screen.queryByRole("radio", { name: "Limit access" })).toBeNull();
    await userEvent.click(
      await screen.findByRole("tab", { name: "Screen access" }),
    );
    // The tab opens on the explicit access choice; location
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
    const request = mockUsersApi(
      [
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
      (path, init) =>
        path === "/api/v1/users" && init?.method === "POST"
          ? json(
              {
                id: "user-3",
                name: "New Editor",
                username: "new-editor",
                role: "editor",
                active: true,
                createdAt: "2026-01-01T00:00:00Z",
              },
              201,
            )
          : undefined,
    );
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

describe("user error localization", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("translates a known API error code in the editor's failure alert", async () => {
    const serverMessage = "Too many requests from this address.";
    mockUsersApi(
      [
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
      (_path, init) =>
        init?.method === "DELETE"
          ? Promise.resolve(
              new Response(
                JSON.stringify({
                  error: { code: "rate_limited", message: serverMessage },
                }),
                {
                  status: 429,
                  headers: { "Content-Type": "application/json" },
                },
              ),
            )
          : undefined,
    );
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
    await userEvent.click(within(row!).getByRole("button", { name: "Edit" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete permanently" }),
    );
    // Switch after the request starts, so the labels above stay English. The
    // failure renders under Spanish.
    await i18n.changeLanguage("es");

    const translated = i18n.t("errors:codes.rate_limited");
    expect(await screen.findByText(translated)).toBeInTheDocument();
    expect(screen.queryByText(serverMessage)).toBeNull();
  }, 15_000);
});

describe("assigning a role and content access", () => {
  async function openEditor(
    handle?: Parameters<typeof mockUsersApi>[1],
    roles = [...roleList, classroomRole],
    rows: Record<string, unknown>[] = [teacherRow],
  ) {
    const request = mockUsersApi(rows, handle, roles);
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <UsersPage />
      </QueryClientProvider>,
    );
    const name = await screen.findByText(String(rows[0]!.name));
    const row = name.closest<HTMLElement>('[data-slot="item"]');
    await userEvent.click(within(row!).getByRole("button", { name: "Edit" }));
    return request;
  }

  it("separates what a person can do from the media and screens they reach", async () => {
    await openEditor();
    const tabs = within(await screen.findByRole("tablist"));
    expect(tabs.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Account",
      "Role",
      "Content access",
      "Screen access",
    ]);
  });

  it("assigns a custom role and saves it with the account", async () => {
    const request = await openEditor();
    await userEvent.click(await screen.findByRole("tab", { name: "Role" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Role" }));
    // Built-in and custom roles are listed apart; the role summary follows.
    await userEvent.click(
      await screen.findByRole("option", { name: "Classroom Media" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const patch = request.mock.calls.find(
        ([input, init]) =>
          requestUrl(input).endsWith("/api/v1/users/user-2") &&
          init?.method === "PATCH",
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch?.[1]?.body as string)).toMatchObject({
        role: "classroom_media",
      });
    });
  });

  it("never offers a role the signed-in account may not hand out", async () => {
    await openEditor(undefined, [
      ...roleList.map((role) =>
        // Only an Owner assigns Owner and Administrator.
        ["owner", "administrator"].includes(role.key)
          ? { ...role, assignable: false }
          : role,
      ),
      classroomRole,
    ]);
    await userEvent.click(await screen.findByRole("tab", { name: "Role" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Role" }));
    const options = (await screen.findAllByRole("option")).map(
      (option) => option.textContent,
    );
    expect(options).toContain("Classroom Media");
    expect(options).toContain("Editor");
    expect(options).not.toContain("Owner");
    expect(options).not.toContain("Administrator");
  });

  it("saves Room 313 and the Room 313 Signage tag as the teacher's content access", async () => {
    const request = await openEditor();
    await userEvent.click(
      await screen.findByRole("tab", { name: "Content access" }),
    );
    await userEvent.click(
      await screen.findByRole("radio", { name: /Only selected folders/ }),
    );
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /Room 313/ }),
    );
    await userEvent.click(
      screen.getByRole("radio", { name: /Only selected tags/ }),
    );
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /Room 313 Signage/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save content access" }),
    );

    await waitFor(() => {
      const put = request.mock.calls.find(
        ([input, init]) =>
          requestUrl(input).endsWith("/api/v1/users/user-2/content-access") &&
          init?.method === "PUT",
      );
      expect(put).toBeDefined();
      expect(JSON.parse(put?.[1]?.body as string)).toEqual({
        libraryMode: "restricted",
        tagMode: "restricted",
        folderIds: ["folder-313"],
        tagIds: ["tag-signage"],
      });
      expect(new Headers(put?.[1]?.headers).get("X-CSRF-Token")).toBe(
        "csrf-token",
      );
    });
  });

  it("warns that an account without a content policy sees no media", async () => {
    await openEditor((path) =>
      /\/content-access$/.test(path)
        ? json({
            policy: {
              libraryMode: "restricted",
              tagMode: "restricted",
              folders: [],
              tags: [],
              configured: false,
            },
            ownerUnrestricted: false,
          })
        : undefined,
    );
    await userEvent.click(
      await screen.findByRole("tab", { name: "Content access" }),
    );
    expect(
      await screen.findByText(/has no content access yet/),
    ).toBeInTheDocument();
  });

  it("never turns a failed load into an editable empty policy", async () => {
    await openEditor((path) =>
      /\/content-access$/.test(path)
        ? Promise.resolve(
            new Response(
              JSON.stringify({ error: { code: "internal", message: "boom" } }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            ),
          )
        : undefined,
    );
    await userEvent.click(
      await screen.findByRole("tab", { name: "Content access" }),
    );
    expect(
      await screen.findByText(/Content access could not be loaded/),
    ).toBeInTheDocument();
    // Saving the placeholder would silently take the person's media away.
    expect(
      screen.queryByRole("button", { name: "Save content access" }),
    ).toBeNull();
  });
});
