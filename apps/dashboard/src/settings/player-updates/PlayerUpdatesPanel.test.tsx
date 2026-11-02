// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  act,
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { api } from "../../api/client";
import { PlayerUpdatesPanel } from "./PlayerUpdatesPanel";
import {
  release,
  fleet,
  groups,
  deployment,
  detail,
  preview,
} from "./fixtures.test-support";

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf", user: { role: "owner" } } }),
}));
let navigateHistory: ReturnType<typeof useNavigate>;
function Probe() {
  const navigate = useNavigate();
  useEffect(() => {
    navigateHistory = navigate;
  }, [navigate]);
  return (
    <>
      <span data-testid="url">{useLocation().search}</span>
      <button onClick={() => void navigate(-1)}>
        {/* i18n-ignore: test navigation control */}History back
      </button>
      <button onClick={() => void navigate(1)}>
        {/* i18n-ignore: test navigation control */}History forward
      </button>
    </>
  );
}
function mount(
  url = "/settings/player/updates?platform=edge",
  manageable = true,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>
        <PlayerUpdatesPanel owner={manageable} manageable={manageable} />
        <Probe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.spyOn(api, "playerReleases").mockResolvedValue({
    repository: "Gibsonmb71/tilecast",
    manifestKeyConfigured: true,
    githubAuth: {
      available: false,
      connected: false,
      source: "anonymous",
      canDisconnect: false,
    },
    items: [release, { ...release, id: "r2", architecture: "aarch64" }],
  });
  vi.spyOn(api, "updateDeployments").mockResolvedValue({ items: [deployment] });
  vi.spyOn(api, "updateDeployment").mockResolvedValue(detail);
  vi.spyOn(api, "screens").mockResolvedValue({
    items: fleet,
    total: fleet.length,
  });
  vi.spyOn(api, "screenGroups").mockResolvedValue({
    items: groups,
    total: groups.length,
    page: 1,
    pageSize: 50,
  });
  vi.spyOn(api, "previewUpdateDeployment").mockImplementation((input) =>
    Promise.resolve(preview(input.screenIds)),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("Player Updates workspace", () => {
  it("keeps terminal failures in history instead of active rollouts", async () => {
    vi.mocked(api.updateDeployments).mockResolvedValue({
      items: [
        { ...deployment, id: "normal", failedCount: 0, waitingForUserCount: 0 },
        {
          ...deployment,
          id: "blocked",
          status: "completed",
          failedCount: 0,
          waitingForUserCount: 0,
          incompatibleCount: 1,
        },
      ],
    });
    mount();
    const table = await screen.findByRole("table");
    expect(
      within(table).getByText("Incompatible screens: 1."),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("button", { name: "View rollout" }),
    ).toBeInTheDocument();
    const activeCard = screen
      .getAllByRole("button", { name: "View rollout" })[0]!
      .closest('[data-slot="card"]');
    expect(activeCard).not.toBeNull();
    expect(
      within(activeCard as HTMLElement).queryByText("Incompatible screens: 1."),
    ).not.toBeInTheDocument();
  });
  it("defaults to Deployments, shows one semantic row, and keeps GitHub auth out of page chrome", async () => {
    mount();
    expect(screen.getByRole("tab", { name: "Deployments" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      await screen.findByText("1 screen needs a retry."),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "View rollout" }),
    ).toHaveLength(1);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("One-time code")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect GitHub" }),
    ).not.toBeInTheDocument();
  });
  it("uses a compact table for completed deployment history", async () => {
    vi.mocked(api.updateDeployments).mockResolvedValue({
      items: [
        {
          ...deployment,
          id: "completed",
          status: "completed",
          succeededCount: 3,
          failedCount: 0,
          waitingForUserCount: 0,
        },
      ],
    });
    mount();
    const table = await screen.findByRole("table");
    expect(within(table).getByText(release.versionName)).toBeInTheDocument();
    expect(within(table).getAllByText("Completed").length).toBeGreaterThan(0);
    expect(
      within(table).getByRole("button", { name: "View rollout" }),
    ).toBeInTheDocument();
  });
  it("uses URL-backed view and family with back/forward, preserving unrelated parameters", async () => {
    mount("/settings/player/updates?platform=edge&keep=yes");
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Releases" }));
    expect(await screen.findByText("Release library")).toBeInTheDocument();
    expect(screen.getByTestId("url")).toHaveTextContent("keep=yes");
    expect(screen.getByTestId("url")).toHaveTextContent("view=releases");
    const family = screen.getByRole("combobox", { name: "Player family" });
    await user.click(family);
    await user.click(await screen.findByRole("option", { name: "Windows" }));
    expect(screen.getByTestId("url")).toHaveTextContent("platform=windows");
    await user.click(screen.getByRole("button", { name: "History back" }));
    expect(
      screen.getByRole("combobox", { name: "Player family" }),
    ).toHaveTextContent("Tilecast Edge");
    await user.click(screen.getByRole("button", { name: "History forward" }));
    expect(
      screen.getByRole("combobox", { name: "Player family" }),
    ).toHaveTextContent("Windows");
  });
  it("discards a draft when navigating to another family and back", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Deploy update" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /x86_64/ }));
    // Browser navigation can change the URL while the modal draft is open.
    await act(async () => {
      await navigateHistory("/settings/player/updates?platform=windows");
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "History back" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deploy update" }));
    expect(
      screen
        .getAllByRole("radio")
        .every((r) => r.getAttribute("aria-checked") === "false"),
    ).toBe(true);
  });
  it("groups only GitHub tag variants and names each deployment action's architecture", async () => {
    mount("/settings/player/updates?platform=edge&view=releases");
    await screen.findByText("Release library");
    expect(
      screen.getAllByRole("button", { name: "0.26.0-beta.6" }),
    ).toHaveLength(1);
    expect(screen.getByText("x86_64")).toBeInTheDocument();
    expect(screen.getByText("aarch64")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Deploy aarch64" }),
    );
    const radio = await screen.findByRole("radio", {
      name: /0.26.0-beta.6.*Beta.*aarch64/,
    });
    // A concrete artifact is selected, even though the version is shared.
    expect(
      screen
        .getAllByRole("radio")
        .filter((r) => r.getAttribute("aria-checked") === "true"),
    ).toHaveLength(1);
    expect(radio).toHaveAttribute("aria-checked", "true");
    expect(radio).toBeInTheDocument();
  });
  it("does not merge direct uploads and shows actual cache bytes", async () => {
    vi.mocked(api.playerReleases).mockResolvedValue({
      repository: "Gibsonmb71/tilecast",
      manifestKeyConfigured: true,
      githubAuth: {
        available: true,
        connected: false,
        source: "anonymous",
        canDisconnect: false,
      },
      items: [
        { ...release, source: "upload", tag: "" },
        {
          ...release,
          id: "r2",
          source: "upload",
          tag: "",
          architecture: "aarch64",
          cacheStatus: "downloading",
          downloadedBytes: 20 * 1024 * 1024,
        },
      ],
    });
    mount("/settings/player/updates?platform=edge&view=releases");
    await screen.findByText(/20 MiB of 50 MiB/);
    expect(
      screen.getAllByRole("button", { name: release.versionName }),
    ).toHaveLength(2);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "40",
    );
  });
  it("shows provider failure as an Alert and preserves releases", async () => {
    vi.mocked(api.playerReleases).mockResolvedValue({
      repository: "Gibsonmb71/tilecast",
      manifestKeyConfigured: true,
      githubAuth: {
        available: false,
        connected: false,
        source: "anonymous",
        canDisconnect: false,
      },
      providerError: "GitHub rate limit reached.",
      items: [release],
    });
    mount("/settings/player/updates?platform=edge&view=releases");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GitHub rate limit reached.",
    );
    expect(screen.getByText(release.versionName)).toBeInTheDocument();
  });
  it("opens rollout detail and limits deployment commands by role", async () => {
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "View rollout" }),
    );
    expect(await screen.findByText("Not enough storage.")).toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog")).getByText("Tilecast Edge · x86_64"),
    ).toBeInTheDocument();
    cleanup();
    mount("/settings/player/updates?platform=edge&view=releases", false);
    await screen.findByText("Release library");
    expect(
      screen.queryByRole("button", { name: /Deploy/ }),
    ).not.toBeInTheDocument();
  });
  it("keeps real rows during background refetch", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <MemoryRouter initialEntries={["/settings/player/updates?platform=edge"]}>
        <QueryClientProvider client={client}>
          <PlayerUpdatesPanel owner manageable />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await screen.findByText("1 screen needs a retry.");
    vi.mocked(api.updateDeployments).mockReturnValue(new Promise(() => {}));
    void client.invalidateQueries({ queryKey: ["update-deployments"] });
    await waitFor(() =>
      expect(client.isFetching({ queryKey: ["update-deployments"] })).toBe(1),
    );
    expect(screen.getByText("1 screen needs a retry.")).toBeInTheDocument();
  });
});
