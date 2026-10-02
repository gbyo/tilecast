// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntegrationTokensPanel } from "./IntegrationTokensPanel";
import { api } from "../api/client";
import { i18n } from "../i18n";
import { toast } from "../components/ui/toast";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf", user: { role: "owner" } } }),
}));

function renderPanel(owner = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <IntegrationTokensPanel owner={owner} />
    </QueryClientProvider>,
  );
}

describe("Integration tokens", () => {
  beforeEach(() => {
    const widen = <T,>(value: unknown) => value as T;
    vi.spyOn(api, "integrationTokens").mockResolvedValue([]);
    vi.spyOn(api, "listDataSources").mockResolvedValue(
      widen<Awaited<ReturnType<typeof api.listDataSources>>>({
        items: [{ id: "d1", name: "Lunch menu", provider: "manual" }],
        total: 1,
      }),
    );
  });
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await i18n.changeLanguage("en");
  });

  it("keeps token management to the Owner", () => {
    renderPanel(false);
    expect(
      screen.getByText(/Only the Owner may manage integration tokens/),
    ).toBeTruthy();
  });

  it("describes each capability", async () => {
    renderPanel();
    expect(
      await screen.findByText(/Replace rows in selected Manual Table/),
    ).toBeTruthy();
  });

  it("marks a newly created token as shown once", async () => {
    vi.spyOn(api, "createIntegrationToken").mockResolvedValue({
      token: {
        id: "t1",
        name: "Menu importer",
        publicId: "abc",
        scopes: ["data_source:write"],
        dataSourceIds: [],
        createdAt: "2026-03-04T12:00:00Z",
      },
      secret: "tci_abc.supersecret",
      notice: "Copy this token now.",
    });
    renderPanel();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Name"), "Menu importer");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    expect(await screen.findByText("tci_abc.supersecret")).toBeTruthy();
    expect(screen.getByText(/Shown once/)).toBeTruthy();
  });

  it("reports a revoked token as revoked and offers no revoke control", async () => {
    vi.spyOn(api, "integrationTokens").mockResolvedValue([
      {
        id: "t1",
        name: "Old importer",
        publicId: "abc",
        scopes: ["data_source:write"],
        dataSourceIds: [],
        createdAt: "2026-03-01T12:00:00Z",
        revokedAt: "2026-03-02T12:00:00Z",
      },
    ]);
    renderPanel();
    expect(await screen.findByText("Revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Revoke Old importer/ })).toBe(
      null,
    );
  });

  it("sends an expiry as the end of the chosen day, and none when left empty", async () => {
    const create = vi.spyOn(api, "createIntegrationToken").mockResolvedValue({
      token: {
        id: "t1",
        name: "Menu importer",
        publicId: "abc",
        scopes: ["data_source:write"],
        dataSourceIds: [],
        createdAt: "2026-03-04T12:00:00Z",
      },
      secret: "tci_abc.secret",
      notice: "",
    });
    renderPanel();
    const user = userEvent.setup();
    const today = new Date();
    const day = today.getDate();
    const calendarDay = new RegExp(
      today.toLocaleString("en-US", { month: "long" }) + " " + day,
    );

    await user.type(await screen.findByLabelText("Name"), "Menu importer");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    // An empty field means a token that never expires, not one that expires now.
    expect(create.mock.calls[0]?.[0]?.expiresAt).toBeUndefined();

    // The name is cleared after a successful create, and it is required.
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue(""));
    await user.type(screen.getByLabelText("Name"), "Menu importer");
    await user.click(screen.getByRole("button", { name: "Expires on" }));
    await user.click(await screen.findByRole("button", { name: calendarDay }));
    const expectedExpiry = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
      23,
      59,
      59,
      999,
    ).toISOString();
    expect(screen.getByRole("button", { name: "Clear date" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const sent = create.mock.calls[1]?.[0]?.expiresAt;
    expect(sent).toBe(expectedExpiry);
    if (!sent) throw new Error("the selected expiry was not sent");
    // The end of the selected local day keeps the token active through that day.
    const when = new Date(sent);
    expect(when.getFullYear()).toBe(today.getFullYear());
    expect(when.getMonth()).toBe(today.getMonth());
    expect(when.getDate()).toBe(today.getDate());
    expect(when.getHours()).toBe(23);
    // The last instant of the day, so nothing in the final second is cut off.
    expect(when.getMinutes()).toBe(59);
    expect(when.getSeconds()).toBe(59);
    expect(when.getMilliseconds()).toBe(999);
  });

  it("distinguishes an expired token from a revoked one", async () => {
    vi.spyOn(api, "integrationTokens").mockResolvedValue([
      {
        id: "t1",
        name: "Lapsed importer",
        publicId: "abc",
        scopes: ["data_source:write"],
        dataSourceIds: [],
        createdAt: "2020-03-01T12:00:00Z",
        expiresAt: "2020-04-01T12:00:00Z",
      },
    ]);
    renderPanel();
    // Expired, not revoked: nobody made a decision about this one, the date
    // simply passed.
    expect(await screen.findByText("Expired")).toBeTruthy();
    expect(screen.queryByText("Revoked")).toBe(null);
    expect(screen.getByText(/Expiry /)).toBeTruthy();
  });

  it("announces token creation in the active locale", async () => {
    await i18n.changeLanguage("es");
    const add = vi.spyOn(toast, "add");
    vi.spyOn(api, "createIntegrationToken").mockResolvedValue({
      token: {
        id: "t1",
        name: "Menu importer",
        publicId: "abc",
        scopes: ["data_source:write"],
        dataSourceIds: [],
        createdAt: "2026-03-04T12:00:00Z",
      },
      secret: "tci_abc.secret",
      notice: "",
    });
    renderPanel();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Nombre"), "Menu importer");
    await user.click(screen.getByRole("button", { name: "Crear token" }));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Token de integración creado.",
          type: "success",
        }),
      ),
    );
  });

  it("announces token revocation in the active locale", async () => {
    await i18n.changeLanguage("es");
    const add = vi.spyOn(toast, "add");
    vi.spyOn(api, "integrationTokens").mockResolvedValue([
      {
        id: "t1",
        name: "Old importer",
        publicId: "abc",
        scopes: ["data_source:write"],
        dataSourceIds: [],
        createdAt: "2026-03-01T12:00:00Z",
      },
    ]);
    vi.spyOn(api, "revokeIntegrationToken").mockResolvedValue(undefined);
    renderPanel();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: "Revocar Old importer" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Revocar" }));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Token de integración revocado.",
          type: "success",
        }),
      ),
    );
  });

  it("reports a token-list failure instead of the empty state", async () => {
    vi.spyOn(api, "integrationTokens").mockRejectedValue(
      new Error("service unavailable"),
    );
    renderPanel();
    expect(await screen.findByText(/Token data failed to load/)).toBeTruthy();
    expect(screen.getByText(/service unavailable/)).toBeTruthy();
    expect(screen.queryByText("No tokens")).toBe(null);
  });

  it("reports a Data Source failure instead of claiming none exist", async () => {
    vi.spyOn(api, "listDataSources").mockRejectedValue(
      new Error("service unavailable"),
    );
    renderPanel();
    expect(
      await screen.findByText(/Data Source data failed to load/),
    ).toBeTruthy();
    expect(screen.queryByText(/No Manual Table Data Sources exist yet/)).toBe(
      null,
    );
  });

  it("sends the named Data Source limits with a write token", async () => {
    const create = vi.spyOn(api, "createIntegrationToken").mockResolvedValue({
      token: {
        id: "t1",
        name: "Menu importer",
        publicId: "abc",
        scopes: ["data_source:write"],
        dataSourceIds: ["d1"],
        createdAt: "2026-03-04T12:00:00Z",
      },
      secret: "tci_abc.secret",
      notice: "",
    });
    renderPanel();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Name"), "Menu importer");
    await user.click(
      await screen.findByRole("checkbox", { name: /Lunch menu/ }),
    );
    await user.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    const [body] = create.mock.calls[0] ?? [];
    expect(body?.dataSourceIds).toEqual(["d1"]);
  });

  it("searches the source list instead of rendering an unbounded wall", async () => {
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [
        { id: "d1", name: "Lunch menu", provider: "manual" },
        { id: "d2", name: "Allergen notes", provider: "manual" },
        { id: "d3", name: "Bus times", provider: "manual" },
      ],
      total: 3,
    } as Awaited<ReturnType<typeof api.listDataSources>>);
    renderPanel();
    const user = userEvent.setup();

    await screen.findByRole("checkbox", { name: /Bus times/ });
    await user.type(
      await screen.findByLabelText("Search Data Sources"),
      "aller",
    );
    expect(screen.queryByRole("checkbox", { name: /Lunch menu/ })).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: /Allergen notes/ }),
    ).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search Data Sources"));
    await user.type(screen.getByLabelText("Search Data Sources"), "zzz");
    expect(
      await screen.findByText("No Data Source matches this search."),
    ).toBeInTheDocument();
  });

  it("summarizes the selection and keeps it across searches", async () => {
    vi.spyOn(api, "listDataSources").mockResolvedValue({
      items: [
        { id: "d1", name: "Lunch menu", provider: "manual" },
        { id: "d2", name: "Allergen notes", provider: "manual" },
      ],
      total: 2,
    } as Awaited<ReturnType<typeof api.listDataSources>>);
    renderPanel();
    const user = userEvent.setup();

    expect(await screen.findByText("0 selected")).toBeInTheDocument();
    await user.click(await screen.findByRole("checkbox", { name: /Lunch/ }));
    expect(await screen.findByText("1 selected")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search Data Sources"), "aller");
    expect(screen.queryByRole("checkbox", { name: /Lunch menu/ })).toBeNull();
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search Data Sources"));
    expect(
      await screen.findByRole("checkbox", { name: /Lunch menu/ }),
    ).toBeChecked();
  });

  it("leaves the token unrestricted when no source is named", async () => {
    const create = vi.spyOn(api, "createIntegrationToken").mockResolvedValue({
      token: {
        id: "t1",
        name: "Wide importer",
        publicId: "abc",
        scopes: ["data_source:write"],
        dataSourceIds: [],
        createdAt: "2026-03-04T12:00:00Z",
      },
      secret: "tci_abc.secret",
      notice: "",
    });
    renderPanel();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Name"), "Wide importer");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    const [body] = create.mock.calls[0] ?? [];
    expect(body?.dataSourceIds).toEqual([]);
  });
});
