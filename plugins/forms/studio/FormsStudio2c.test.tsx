// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router";
import { FormDataSourcePage } from "./FormDataSourcePage";
import { StudioSessionProvider } from "@tilecast/studio/testing";
import { formsApi } from "./api";
import { ApiError } from "@tilecast/studio";

import type {
  FormCapability,
  FormDataSource,
  FormView,
  FormWorkflow,
} from "./types";

class RequestWithoutSignal extends globalThis.Request {
  constructor(input: RequestInfo | URL, init: RequestInit = {}) {
    const rest = { ...init };
    delete (rest as { signal?: unknown }).signal;
    super(input, rest);
  }
}
globalThis.Request = RequestWithoutSignal;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function testSession(role = "viewer") {
  return {
    csrfToken: "tok",
    role,
    canManage: role === "owner" || role === "administrator",
    authenticated: true,
    setupRequired: false,
    isLoading: false,
    isSubmitting: false,
    logout: () => Promise.resolve(),
  };
}

const workflow: FormWorkflow = {
  states: [
    {
      key: "draft",
      label: "Draft",
      position: 0,
      eligibleForOutput: false,
      initial: true,
      terminal: false,
      recordCount: 2,
      removable: false,
    },
    {
      key: "submitted",
      label: "Submitted",
      position: 1,
      eligibleForOutput: false,
      initial: false,
      terminal: false,
      recordCount: 0,
      removable: true,
    },
    {
      key: "approved",
      label: "Approved",
      position: 2,
      eligibleForOutput: true,
      initial: false,
      terminal: false,
      recordCount: 0,
      removable: false,
    },
  ],
  transitions: [
    {
      from: "draft",
      to: "submitted",
      label: "Submit",
      requiredCapability: "submit",
      position: 0,
    },
    {
      from: "submitted",
      to: "approved",
      label: "Approve",
      requiredCapability: "approve",
      position: 1,
    },
  ],
};

const schema = {
  fields: [
    {
      key: "title",
      label: "Title",
      control: "short_text" as const,
      required: true,
    },
  ],
};

function form(
  capabilities: FormCapability[],
  overrides: Partial<FormDataSource> = {},
): FormDataSource {
  return {
    id: "f1",
    name: "Announcements",
    description: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    draftSchema: schema,
    publishedRevision: {
      id: "r1",
      dataSourceId: "f1",
      revisionNumber: 1,
      title: "Announcement",
      description: "",
      schema,
      publishedAt: "2026-01-01T00:00:00Z",
    },
    workflow,
    views: [],
    grantedCapabilities: capabilities,
    ...overrides,
  };
}

const view: FormView = {
  id: "v1",
  key: "highlights",
  name: "Highlights",
  includedStates: ["approved"],
  fieldFilters: [],
  timeFilter: { enabled: false },
  sort: [],
  outputFields: ["title"],
  recordLimit: 100,
  position: 0,
};

function renderPage(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [{ path: "/plugins/forms/:id", element: <FormDataSourcePage /> }],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <StudioSessionProvider session={testSession("editor")}>
        <RouterProvider router={router} />
      </StudioSessionProvider>
    </QueryClientProvider>,
  );
  return router;
}

function stubResponses() {
  vi.spyOn(formsApi, "listFormRecords").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 25,
  });
}

describe("Form tabs — capability visibility and normalization", () => {
  it("shows every tab to a manager", async () => {
    stubResponses();
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["manage"]));
    renderPage("/plugins/forms/f1");

    for (const label of [
      "Responses",
      "Form",
      "Workflow",
      "Views",
      "Outputs",
      "Access",
    ]) {
      expect(
        await screen.findByRole("tab", { name: label }),
      ).toBeInTheDocument();
    }
  });

  it("hides manager-only tabs from a view-all reviewer and normalizes a direct URL", async () => {
    stubResponses();
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["view_all"]));
    // Deep-link to a manager-only tab; it must normalize away.
    const router = renderPage("/plugins/forms/f1?tab=workflow");

    expect(
      await screen.findByRole("tab", { name: "Responses" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Outputs" })).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Workflow" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Views" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Access" }),
    ).not.toBeInTheDocument();
    // The Workflow editor never renders for an unauthorized deep link.
    expect(
      screen.queryByRole("button", { name: "Add state" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toBe("?tab=form"));
  });

  it("replaces an invalid tab and removes a stale record when Responses is unavailable", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["submit"]));
    const router = renderPage(
      "/plugins/forms/f1?tab=not-a-tab&record=stale&keep=yes",
    );

    expect(await screen.findByText("Read-only")).toBeInTheDocument();
    await waitFor(() => {
      expect(router.state.location.search).toBe("?tab=form&keep=yes");
    });
  });
});

describe("Workflow tab", () => {
  it("locks the key and deletion for states referenced by records", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["manage"]));
    renderPage("/plugins/forms/f1?tab=workflow");

    // The used "draft" state (recordCount 2, removable false) has a locked key and delete control.
    // Hidden select inputs mirror option values, so name the visible key field
    // rather than matching on its value alone.
    const keyInputs = await screen.findAllByRole("textbox", { name: "Key" });
    const draftKey = keyInputs.find(
      (input) => (input as HTMLInputElement).value === "draft",
    );
    expect(draftKey).toBeDefined();
    expect(draftKey).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Draft" })).toBeDisabled();
    // An unused state remains editable/removable.
    expect(
      screen.getByRole("button", { name: "Delete Submitted" }),
    ).toBeEnabled();
  });

  it.each([
    ["pathname", "/somewhere-else"],
    ["query string", "/plugins/forms/f1?tab=views"],
    ["hash", "/plugins/forms/f1?tab=workflow#transitions"],
  ])(
    "blocks %s navigation and keeps beforeunload while dirty",
    async (_kind, target) => {
      vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["manage"]));
      const user = userEvent.setup();
      const router = renderPage("/plugins/forms/f1?tab=workflow");

      const labels = await screen.findAllByLabelText("Label");
      await user.type(labels[0]!, " changed");
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);

      await act(async () => {
        await router.navigate(target);
      });
      expect(
        await screen.findByText("Leave without saving?"),
      ).toBeInTheDocument();
    },
  );
});

describe("Views tab", () => {
  it("blocks deletion of a referenced view with a usage message", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(
      form(["manage"], { views: [view] }),
    );
    vi.spyOn(formsApi, "deleteFormView").mockRejectedValue(
      new ApiError(
        "this view's dataset is used by widget Board",
        409,
        "resource_in_use",
      ),
    );
    const user = userEvent.setup();
    renderPage("/plugins/forms/f1?tab=views");

    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(
      await screen.findByText(/used by widget Board/i),
    ).toBeInTheDocument();
  });

  it("previews an unsaved view without saving", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["manage"]));
    const preview = vi.spyOn(formsApi, "previewFormView").mockResolvedValue({
      id: "proposed",
      kind: "records",
      fields: [{ key: "title", label: "Title", type: "text" }],
      records: [{ id: "rec1", values: { title: "Live one" } }],
    });
    const save = vi.spyOn(formsApi, "upsertFormView");
    const user = userEvent.setup();
    renderPage("/plugins/forms/f1?tab=views");

    await user.click(await screen.findByRole("button", { name: "New view" }));
    await user.type(await screen.findByLabelText("View name"), "Proposed");
    await user.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(await screen.findByText("Live one")).toBeInTheDocument();
    // Previewing never saves.
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    ["pathname", "/somewhere-else"],
    ["query string", "/plugins/forms/f1?tab=workflow"],
    ["hash", "/plugins/forms/f1?tab=views#preview"],
  ])(
    "blocks %s navigation and keeps beforeunload while dirty",
    async (_kind, target) => {
      vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["manage"]));
      const user = userEvent.setup();
      const router = renderPage("/plugins/forms/f1?tab=views");

      await user.click(await screen.findByRole("button", { name: "New view" }));
      await user.type(await screen.findByLabelText("View name"), "Draft view");
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);

      await act(async () => {
        await router.navigate(target);
      });
      expect(
        await screen.findByText("Leave without saving?"),
      ).toBeInTheDocument();
    },
  );
});

describe("Outputs tab", () => {
  it("shows eligible record counts and rebuilds on demand", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["manage"]));
    vi.spyOn(formsApi, "getFormOutputs").mockResolvedValue({
      views: [
        {
          key: "approved",
          name: "Approved",
          fields: [{ key: "title", label: "Title", type: "text" }],
          recordCount: 1,
          previewRecords: [{ id: "rec1", values: { title: "Approved one" } }],
          usage: { widgets: 0, layouts: 0, names: [] },
        },
      ],
      lastSuccessAt: "2026-01-05T00:00:00Z",
      nextRefreshAt: null,
      usingCachedData: false,
      errorCode: null,
      stale: false,
    });
    const rebuild = vi.spyOn(formsApi, "rebuildFormOutputs").mockResolvedValue({
      views: [],
      usingCachedData: false,
      stale: false,
    });
    const user = userEvent.setup();
    renderPage("/plugins/forms/f1?tab=outputs");

    expect(await screen.findByText("Approved one")).toBeInTheDocument();
    expect(screen.getByText("1 record")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rebuild outputs" }));
    await waitFor(() => expect(rebuild).toHaveBeenCalled());
  });
});

describe("Access tab", () => {
  it("locks the creator and replaces a user's grants", async () => {
    vi.spyOn(formsApi, "getForm").mockResolvedValue(form(["manage"]));
    vi.spyOn(formsApi, "listFormAccess").mockResolvedValue([
      {
        userId: "manager",
        name: "Mia",
        username: "mia",
        role: "editor",
        capabilities: ["manage"],
        isCreator: true,
        isGlobalOwner: false,
      },
      {
        userId: "owner2",
        name: "Olivia",
        username: "olivia",
        role: "owner",
        capabilities: ["manage"],
        isCreator: false,
        isGlobalOwner: true,
      },
      {
        userId: "u2",
        name: "Alice",
        username: "alice",
        role: "viewer",
        capabilities: ["view_own"],
        isCreator: false,
        isGlobalOwner: false,
      },
    ]);
    const replace = vi
      .spyOn(formsApi, "replaceFormGrants")
      .mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage("/plugins/forms/f1?tab=access");

    // The creator is an unremovable manager (no Edit control).
    expect(await screen.findByText("Manager (creator)")).toBeInTheDocument();
    expect(screen.getByText("Manager (Owner)")).toBeInTheDocument();
    // Edit Alice's access and save. The checkbox query uses the checkbox
    // role so Base UI's hidden mirror input is not matched as well.
    await user.click(screen.getByRole("button", { name: "Edit access" }));
    await user.click(await screen.findByRole("checkbox", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Save access" }));

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace.mock.calls[0]![1]).toBe("u2");
    expect(replace.mock.calls[0]![2]).toContain("review");
  });
});
