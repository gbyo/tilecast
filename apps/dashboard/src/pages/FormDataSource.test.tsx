// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryRouter,
  type RouteObject,
} from "react-router";
import { DataSourceEditorPage } from "./DataSourcesPage";
import { api } from "../api/client";
import * as authModule from "../auth/AuthProvider";
import type {
  DataSourceDetail,
  FormCapability,
  FormDataSource,
} from "../api/types";
import { CreateFormDataSourcePage } from "./CreateFormDataSourcePage";
import { FormDataSourcePage } from "./FormDataSourcePage";

// The React Router data router creates a Request with an AbortSignal on navigation. Under jsdom the
// global AbortSignal is jsdom's, which Node's undici Request rejects. Since these tests never issue
// real network requests (the api client is spied), drop the signal so in-memory navigation works.
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

function mockAuth(role: "owner" | "administrator" | "editor" | "viewer") {
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    status: {
      authenticated: true,
      user: { id: "u1", name: "User", username: "user", role },
      csrfToken: "tok",
    },
    isLoading: false,
  } as unknown as ReturnType<typeof authModule.useAuth>);
}

function renderAt(path: string, extraRoutes: RouteObject[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // A data router is required so FormBuilder's useBlocker (unsaved-change navigation guard) works.
  const router = createMemoryRouter(
    [
      { path: "/data-sources/new", element: <DataSourceEditorPage /> },
      {
        path: "/data-sources/new/:provider",
        element: <DataSourceEditorPage />,
      },
      { path: "/data-sources/:id", element: <DataSourceEditorPage /> },
      { path: "/plugins/forms/new", element: <CreateFormDataSourcePage /> },
      { path: "/plugins/forms/:id", element: <FormDataSourcePage /> },
      ...extraRoutes,
    ],
    { initialEntries: [path] },
  );
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}

const formDetail = (capabilities: FormCapability[]): FormDataSource => ({
  id: "f1",
  name: "Staff Announcements",
  description: "By staff.",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  draftSchema: {
    title: "Announcement",
    description: "",
    fields: [
      { key: "title", label: "Title", control: "short_text", required: true },
    ],
  },
  publishedRevision: {
    id: "r1",
    dataSourceId: "f1",
    revisionNumber: 1,
    title: "Announcement",
    description: "",
    schema: {
      fields: [
        { key: "title", label: "Title", control: "short_text", required: true },
      ],
    },
    publishedAt: "2026-01-01T00:00:00Z",
  },
  workflow: { states: [], transitions: [] },
  views: [],
  grantedCapabilities: capabilities,
});

const formDataSourceDetail = {
  id: "f1",
  provider: "form",
  name: "Staff Announcements",
  description: "By staff.",
  configVersion: 1,
  configuration: {},
  status: "ready",
  cachedRecordCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  diagnostics: {},
  fields: [],
  widgetUsage: [],
  bindingUsage: [],
} as unknown as DataSourceDetail;

describe("Form Data Source Studio", () => {
  it("does not present Forms as a Data Source provider", async () => {
    mockAuth("owner");
    vi.spyOn(api, "providerCatalog").mockResolvedValue({
      providers: [],
    } as never);
    vi.spyOn(api, "contentDefinitions").mockResolvedValue({
      widgets: [],
      dataSources: [
        {
          id: "form",
          name: "Form",
          description: "Collect submissions from staff.",
          icon: "form_input",
          legacyEditor: true,
        },
      ],
    } as never);
    renderAt("/data-sources/new");

    expect(
      await screen.findByRole("heading", { name: "Create Data Source" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Form/ })).toBeNull();
  });

  it("creates a Form with the seeded Title field and navigates to the builder", async () => {
    mockAuth("owner");
    const createForm = vi
      .spyOn(api, "createForm")
      .mockResolvedValue(formDetail(["manage"]));
    vi.spyOn(api, "getDataSource").mockResolvedValue(formDataSourceDetail);
    vi.spyOn(api, "getForm").mockResolvedValue(formDetail(["manage"]));
    const user = userEvent.setup();
    renderAt("/plugins/forms/new");

    // Guided creation: purpose first, then display, then review and create.
    await user.type(
      await screen.findByLabelText(/Form name/),
      "Staff Announcements",
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await screen.findByText("What do submitters see first?"),
    ).toBeInTheDocument();
    // Optional questions are skipped; skipping the last one submits.
    await user.click(await screen.findByRole("button", { name: "Skip" }));
    await user.click(await screen.findByRole("button", { name: "Skip" }));
    await user.click(await screen.findByRole("button", { name: "Skip" }));
    expect(
      await screen.findByRole("heading", { name: "Review and create" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create form" }));

    await waitFor(() => expect(createForm).toHaveBeenCalled());
    const [input] = createForm.mock.calls[0]!;
    expect(input.name).toBe("Staff Announcements");
    expect(input.draftSchema.fields[0]).toMatchObject({
      key: "title",
      control: "short_text",
      required: true,
    });
  });

  it("blocks guided creation until the form has a name", async () => {
    mockAuth("owner");
    const createForm = vi
      .spyOn(api, "createForm")
      .mockResolvedValue(formDetail(["manage"]));
    const user = userEvent.setup();
    renderAt("/plugins/forms/new");

    await screen.findByLabelText(/Form name/);
    await user.click(screen.getByRole("button", { name: "Next" }));
    // The required purpose question blocks progress until it is answered.
    expect(await screen.findByText("Question 1 of 4")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Review and create" }),
    ).not.toBeInTheDocument();
    expect(createForm).not.toHaveBeenCalled();
  });

  it("lets a global Viewer with a manage grant edit the form", async () => {
    mockAuth("viewer");
    vi.spyOn(api, "getDataSource").mockResolvedValue(formDataSourceDetail);
    vi.spyOn(api, "getForm").mockResolvedValue(formDetail(["manage"]));
    renderAt("/data-sources/f1?tab=form");

    expect(
      await screen.findByRole("button", { name: "Save draft" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
  });

  it("shows a read-only view to a user without manage", async () => {
    mockAuth("viewer");
    vi.spyOn(api, "getDataSource").mockResolvedValue(formDataSourceDetail);
    vi.spyOn(api, "getForm").mockResolvedValue(formDetail(["submit"]));
    renderAt("/data-sources/f1?tab=form");

    expect(await screen.findByText("Read-only")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save draft" }),
    ).not.toBeInTheDocument();
  });

  it("blocks internal navigation with unsaved changes; cancel stays and confirm leaves", async () => {
    mockAuth("owner");
    vi.spyOn(api, "getDataSource").mockResolvedValue(formDataSourceDetail);
    vi.spyOn(api, "getForm").mockResolvedValue(formDetail(["manage"]));
    const user = userEvent.setup();
    const { router } = renderAt("/data-sources/f1?tab=form", [
      { path: "/screens", element: <div>Screens page</div> },
    ]);

    // Make an unsaved schema change.
    await user.type(await screen.findByLabelText("Form title"), "X");

    // Attempt to navigate away -> blocked with a confirmation prompt.
    await act(async () => {
      await router.navigate("/screens");
    });
    expect(
      await screen.findByText("Leave without saving?"),
    ).toBeInTheDocument();

    // Cancel keeps us on the builder.
    await user.click(screen.getByRole("button", { name: "Stay on page" }));
    expect(screen.queryByText("Screens page")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save draft" }),
    ).toBeInTheDocument();

    // Retry and confirm -> navigation proceeds.
    await act(async () => {
      await router.navigate("/screens");
    });
    await user.click(
      await screen.findByRole("button", { name: "Leave without saving" }),
    );
    expect(await screen.findByText("Screens page")).toBeInTheDocument();
  });

  it("disables Publish when the draft matches the published revision", async () => {
    mockAuth("owner");
    const identicalSchema = {
      title: "Announcement",
      description: "",
      fields: [
        { key: "title", label: "Title", control: "short_text", required: true },
      ],
    };
    const detail = formDetail(["manage"]);
    detail.draftSchema = identicalSchema as never;
    detail.publishedRevision = {
      ...detail.publishedRevision!,
      schema: identicalSchema as never,
    };
    vi.spyOn(api, "getDataSource").mockResolvedValue(formDataSourceDetail);
    vi.spyOn(api, "getForm").mockResolvedValue(detail);
    const user = userEvent.setup();
    renderAt("/data-sources/f1?tab=form");

    expect(
      await screen.findByRole("button", { name: "Publish" }),
    ).toBeDisabled();

    // Editing the schema makes it publishable again.
    await user.type(screen.getByLabelText("Form title"), "!");
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
  });

  it("disables Publish when a differing draft is edited back to match published", async () => {
    mockAuth("owner");
    const published = {
      title: "Announcement",
      description: "",
      fields: [
        { key: "title", label: "Title", control: "short_text", required: true },
      ],
    };
    const detail = formDetail(["manage"]);
    detail.publishedRevision = {
      ...detail.publishedRevision!,
      schema: published as never,
    };
    // The saved draft differs from published only by its title.
    detail.draftSchema = {
      ...published,
      title: "Announcement CHANGED",
    } as never;
    vi.spyOn(api, "getDataSource").mockResolvedValue(formDataSourceDetail);
    vi.spyOn(api, "getForm").mockResolvedValue(detail);
    const user = userEvent.setup();
    renderAt("/data-sources/f1?tab=form");

    const title = await screen.findByLabelText("Form title");
    // A differing draft is publishable even before any local edit (not gated on dirty).
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();

    // Editing the draft back to exactly match the published schema disables Publish.
    await user.clear(title);
    await user.type(title, "Announcement");
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("blocks navigation when only the query string changes with unsaved edits", async () => {
    mockAuth("owner");
    vi.spyOn(api, "getDataSource").mockResolvedValue(formDataSourceDetail);
    vi.spyOn(api, "getForm").mockResolvedValue(formDetail(["manage"]));
    const user = userEvent.setup();
    const { router } = renderAt("/data-sources/f1?tab=form");

    await user.type(await screen.findByLabelText("Form title"), "X");

    // Same pathname, different query string -> still blocked.
    await act(async () => {
      await router.navigate("/data-sources/f1?tab=preview");
    });
    expect(
      await screen.findByText("Leave without saving?"),
    ).toBeInTheDocument();
  });

  it("blocks switching Form tabs while the builder is dirty", async () => {
    mockAuth("owner");
    vi.spyOn(api, "getDataSource").mockResolvedValue(formDataSourceDetail);
    vi.spyOn(api, "getForm").mockResolvedValue(formDetail(["manage"]));
    const user = userEvent.setup();
    renderAt("/data-sources/f1?tab=form");

    await user.type(await screen.findByLabelText("Form title"), "X");
    await user.click(screen.getByRole("button", { name: "Workflow" }));

    expect(
      await screen.findByText("Leave without saving?"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save draft" }),
    ).toBeInTheDocument();
  });
});
