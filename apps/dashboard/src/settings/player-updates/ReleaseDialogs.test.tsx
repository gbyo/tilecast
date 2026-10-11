// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { ReleaseUploadDialog } from "./ReleaseUploadDialog";
import { ReleaseSourceDialog } from "./ReleaseSourceDialog";
import { release } from "./fixtures.test-support";

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf", user: { role: "owner" } } }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(node: React.ReactNode) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      {node}
    </QueryClientProvider>,
  );
}
const files = () => [
  new File(["artifact"], "tilecast-edge-0.26.0-beta.6-x86_64.tar.zst"),
  new File(["manifest"], "tilecast-edge-update.json"),
  new File(["signature"], "tilecast-edge-update.json.sig"),
];
describe("release dialogs", () => {
  it("maps exactly three signed files and rejects unexpected or oversized files", async () => {
    mount(
      <ReleaseUploadDialog
        family="edge"
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    const user = userEvent.setup({ applyAccept: false });
    const input = screen.getByLabelText(/Drop/);
    const submit = screen.getByRole("button", { name: "Upload and verify" });
    expect(submit).toBeDisabled();
    await user.upload(input, new File(["bad"], "wrong.json"));
    expect(screen.getByRole("alert")).toHaveTextContent("wrong.json");
    await user.upload(
      input,
      new File([new Uint8Array(16385)], "tilecast-edge-update.json"),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("must not exceed");
    await user.upload(input, files());
    expect(
      screen.getByText("tilecast-edge-0.26.0-beta.6-x86_64.tar.zst"),
    ).toBeVisible();
    expect(submit).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Clear files" }));
    expect(submit).toBeDisabled();
  });
  it("separates measurable transfer from verification and reports success", async () => {
    let report: (value: number) => void = () => {};
    const importedRelease = { ...release, duplicate: false };
    let finish: (
      value: Awaited<ReturnType<typeof api.uploadPlayerRelease>>,
    ) => void = () => {};
    vi.spyOn(api, "uploadPlayerRelease").mockImplementation(
      (_files, _csrf, onProgress) => {
        report = onProgress!;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const imported = vi.fn();
    mount(
      <ReleaseUploadDialog
        family="edge"
        onClose={() => {}}
        onImported={imported}
      />,
    );
    await userEvent.upload(screen.getByLabelText(/Drop/), files());
    await userEvent.click(
      screen.getByRole("button", { name: "Upload and verify" }),
    );
    await waitFor(() => expect(api.uploadPlayerRelease).toHaveBeenCalled());
    act(() => report(45));
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "45",
    );
    act(() => report(100));
    expect(screen.getByText("Verifying signed release…")).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    await act(async () => {
      finish(importedRelease);
      await Promise.resolve();
    });
    await waitFor(() => expect(imported).toHaveBeenCalledOnce());
  });
  it("keeps authoritative signature failures in the upload dialog", async () => {
    vi.spyOn(api, "uploadPlayerRelease").mockRejectedValue(
      new Error("Manifest signature did not verify."),
    );
    mount(
      <ReleaseUploadDialog
        family="edge"
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    await userEvent.upload(screen.getByLabelText(/Drop/), files());
    await userEvent.click(
      screen.getByRole("button", { name: "Upload and verify" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Manifest signature did not verify.",
    );
  });
  it("keeps device authorization in a dialog and exposes only the user code", async () => {
    vi.spyOn(api, "startGitHubDeviceAuthorization").mockResolvedValue({
      flowId: "flow",
      userCode: "CODE-TEST",
      verificationUri: "https://github.com/login/device",
      pollIntervalSeconds: 10,
      expiresAt: "2026-10-11T18:10:00Z",
    });
    const close = vi.fn();
    mount(
      <ReleaseSourceDialog
        github={{
          available: true,
          connected: false,
          source: "anonymous",
          canDisconnect: false,
        }}
        onClose={close}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Connect GitHub" }),
    );
    expect(await screen.findByText("CODE-TEST")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/login/device",
    );
    expect(screen.getByText(/Waiting for authorization/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalledOnce();
  });
});
