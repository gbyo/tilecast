// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../../api/client";
import { DeployUpdateSheet } from "./DeployUpdateSheet";
import { release, fleet, groups, preview } from "./fixtures.test-support";
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf", user: { role: "owner" } } }),
}));
let created = vi.fn();
const releases = [release, { ...release, id: "r2", architecture: "aarch64" }];
function mount(preselected?: string, releaseItems = releases) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DeployUpdateSheet
        releases={releaseItems}
        screens={fleet}
        groups={groups}
        initialFamily="edge"
        preselected={preselected}
        onClose={() => {}}
        onCreated={created}
      />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  created = vi.fn();
  vi.spyOn(api, "previewUpdateDeployment").mockImplementation((input) =>
    Promise.resolve(
      preview([
        ...input.screenIds,
        ...(input.groupIds.includes("g1") ? ["s1", "s2"] : []),
      ]),
    ),
  );
  vi.spyOn(api, "createUpdateDeployment").mockResolvedValue({
    id: "created",
    targetCount: 2,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function goTargets() {
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("combobox");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Select all eligible" }),
    ).toBeEnabled(),
  );
}
async function selectEligible() {
  await userEvent.click(
    screen.getByRole("button", { name: "Select all eligible" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
  );
}
describe("guided deployment", () => {
  it("requires a concrete artifact, distinguishes architectures, and preserves valid Back state", async () => {
    mount();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await userEvent.click(screen.getByRole("combobox", { name: "Version" }));
    await userEvent.click(
      await screen.findByRole("option", { name: /0.26.0-beta.6/ }),
    );
    expect(
      screen.getByRole("radio", {
        name: "Intel / AMD 64-bit (x86_64)",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "ARM64 (aarch64)" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("radio", {
        name: "Intel / AMD 64-bit (x86_64)",
      }),
    );
    await goTargets();
    await selectEligible();
    expect(screen.getByText("2 screens selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("3 of 3 — Rollout")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("2 screens selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("radio", {
        name: "Intel / AMD 64-bit (x86_64)",
      }),
    ).toHaveAttribute("aria-checked", "true");
  });
  it("prepares an uncached build without leaving the deploy flow", async () => {
    const cold = {
      ...release,
      cacheStatus: "missing" as const,
      verificationStatus: "verified_manifest" as const,
    };
    vi.spyOn(api, "cachePlayerRelease").mockResolvedValue({
      id: cold.id,
      cacheStatus: "downloading",
    });
    vi.spyOn(api, "playerReleases").mockResolvedValue({
      repository: "Gibsonmb71/tilecast",
      manifestKeyConfigured: true,
      githubAuth: {
        available: true,
        connected: false,
        source: "anonymous",
        canDisconnect: false,
      },
      items: [
        {
          ...cold,
          cacheStatus: "cached",
          verificationStatus: "verified",
        },
      ],
    });

    mount("r1", [cold]);
    expect(
      screen.getByRole("button", { name: "Prepare & continue" }),
    ).toBeEnabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Prepare & continue" }),
    );
    await screen.findByRole("combobox", { name: /targets/i });
    expect(api.cachePlayerRelease).toHaveBeenCalledWith("r1", "csrf");
    expect(screen.getByText(/0.26.0-beta.6/)).toBeInTheDocument();
  });

  it("searches screens and Display Groups, explains disabled incompatibility, and resolves group membership", async () => {
    mount("r1");
    await goTargets();
    await userEvent.click(screen.getByRole("combobox"));
    expect(
      await screen.findByText(/requires x86_64 architecture/),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /ARM Hall/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.type(screen.getByRole("combobox"), "Main");
    await userEvent.click(
      await screen.findByRole("option", { name: /Main building/ }),
    );
    expect(
      screen.getByRole("button", { name: "Remove Main building" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("2 screens selected")).toBeInTheDocument(),
    );
    expect(api.previewUpdateDeployment).toHaveBeenCalledWith(
      { releaseId: "r1", screenIds: [], groupIds: ["g1"] },
      "csrf",
    );
    expect(
      screen.getByText(/command waits for reconnection/),
    ).toBeInTheDocument();
  });
  it("blocks group targets when server preflight reports an exact incompatibility", async () => {
    vi.mocked(api.previewUpdateDeployment).mockImplementation((input) =>
      Promise.resolve(
        preview(input.groupIds.length ? ["s1", "s3"] : input.screenIds),
      ),
    );
    mount("r1");
    await goTargets();
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(
      await screen.findByRole("option", { name: /Main building/ }),
    );
    await userEvent.keyboard("{Escape}");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("ARM Hall");
    expect(alert).toHaveTextContent("reports aarch64");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(api.createUpdateDeployment).not.toHaveBeenCalled();
  });
  it("renders maintenance and canary inputs only for their choices and reviews the final selection", async () => {
    mount("r1");
    await goTargets();
    await selectEligible();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.queryByText("Maintenance window time"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Deployment mode" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Maintenance window" }),
    );
    expect(
      screen.getByText("Choose a future date and time."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Deploy update" }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Deployment mode" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Install now" }),
    );
    expect(
      screen.queryByText("Choose a future date and time."),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Rollout safeguards" }),
    );
    await userEvent.click(
      screen.getByRole("switch", { name: "Canary rollout" }),
    );
    expect(
      screen.getByRole("spinbutton", { name: "Canary screens" }),
    ).toHaveValue(1);
    const summary = screen.getByRole("region", { name: "Deployment review" });
    expect(summary).toHaveTextContent(release.versionName);
    expect(summary).toHaveTextContent(
      "Tilecast Edge · Intel / AMD 64-bit (x86_64)",
    );
    expect(summary).toHaveTextContent(
      "2 screens · Install now · 1 canary screen",
    );
    await userEvent.clear(screen.getByRole("spinbutton"));
    await userEvent.type(screen.getByRole("spinbutton"), "2");
    expect(
      screen.getByRole("button", { name: "Deploy update" }),
    ).toBeDisabled();
  });
  it("creates one reviewed rollout without a second confirmation", async () => {
    mount("r1");
    await goTargets();
    await selectEligible();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Deploy update" }),
    );
    await waitFor(() =>
      expect(created).toHaveBeenCalledWith("created", "edge"),
    );
    expect(api.createUpdateDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseId: "r1",
        screenIds: ["s1", "s2"],
        groupIds: [],
        mode: "install_now",
        canarySize: 0,
      }),
      "csrf",
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
  it("disables final deploy while a refreshed preflight is unresolved", async () => {
    mount("r1");
    await goTargets();
    await selectEligible();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: "Deploy update" })).toBeEnabled();
    // Changing targets creates a new query and cannot reuse the old preview.
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    vi.mocked(api.previewUpdateDeployment).mockReturnValue(
      new Promise(() => {}),
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove Lobby" }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});
