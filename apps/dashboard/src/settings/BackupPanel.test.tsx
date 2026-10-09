// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../api/client";
import type { BackupArchive, BackupList } from "../api/types";
import { BackupPanel } from "./BackupPanel";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf", user: { id: "u1", role: "owner" } },
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const archive = {
  id: "bk-1",
  fileName: "lobby-2026-10-01.tcbackup",
  kind: "manual",
  status: "complete",
  sizeBytes: 2048,
  archiveSha256: "aabb",
  tilecastVersion: "1.0.0",
  schemaVersion: 1,
  installationId: "inst-1",
  organizationName: "Tilecast",
  components: [],
  verification: "verified",
  createdAt: "2026-10-01T00:00:00Z",
} as BackupArchive;

const list = {
  backups: [archive],
  currentJob: null,
  recentJobs: [],
  lastSuccessful: archive,
  schedule: { enabled: false },
} as unknown as BackupList;

describe("BackupPanel deletion", () => {
  it("treats declining the last-backup confirmation as a cancellation", async () => {
    vi.spyOn(api, "backups").mockResolvedValue(list);
    const remove = vi
      .spyOn(api, "deleteBackup")
      .mockRejectedValueOnce(
        new ApiError(
          "This is the last complete backup",
          409,
          "last_backup_protected",
        ),
      );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <BackupPanel owner />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: `Delete ${archive.fileName}`,
      }),
    );
    // First confirmation: delete the file. Second: the protected last backup.
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(
      await screen.findByText(
        "This is the last complete backup. Delete it anyway?",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.queryByText(
          "This is the last complete backup. Delete it anyway?",
        ),
      ).toBeNull(),
    );
    // The refusal was a choice, not a failed delete: no error is shown and the
    // archive was requested only once, without force.
    expect(screen.queryByText("This is the last complete backup")).toBeNull();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("bk-1", false, "csrf");
  });
});
