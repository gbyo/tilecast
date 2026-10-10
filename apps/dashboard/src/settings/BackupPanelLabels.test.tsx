// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { BackupArchive, BackupJob } from "../api/types";
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
  id: "bk-2",
  fileName: "lobby-2026-10-02.tcbackup",
  kind: "pre_restore",
  status: "complete",
  sizeBytes: 2048,
  archiveSha256: "aabb",
  tilecastVersion: "1.0.0",
  schemaVersion: 1,
  installationId: "inst-1",
  organizationName: "Tilecast",
  components: [],
  verification: "unverified",
  createdAt: "2026-10-02T00:00:00Z",
} as BackupArchive;

describe("BackupPanel labels", () => {
  it("shows translated kind and verification labels rather than backend tokens", async () => {
    vi.spyOn(api, "backups").mockResolvedValue({
      backups: [archive],
      currentJob: null,
      recentJobs: [],
      lastSuccessful: null,
      schedule: {},
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <BackupPanel owner />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Before restore/)).toBeInTheDocument();
    expect(screen.getByText("Not verified")).toBeInTheDocument();
    // The backend tokens are not shown to the user.
    expect(screen.queryByText(/pre_restore/)).toBeNull();
    expect(screen.queryByText("unverified")).toBeNull();
  });

  it("shows a fixed job phase translated and a dynamic phase as the server sent it", async () => {
    const running = (phase: string): BackupJob => ({
      id: "job-1",
      kind: "verify",
      trigger: "manual",
      status: "running",
      phase,
      progressPercent: 5,
      createdAt: "2026-10-02T00:00:00Z",
    });
    vi.spyOn(api, "backups").mockResolvedValue({
      backups: [archive],
      currentJob: running("verifying_archive"),
      recentJobs: [],
      lastSuccessful: null,
      schedule: {},
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <BackupPanel owner />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("Verifying archive · 5%"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/verifying_archive/)).toBeNull();
    unmount();

    vi.spyOn(api, "backups").mockResolvedValue({
      backups: [archive],
      currentJob: running("archiving_media"),
      recentJobs: [],
      lastSuccessful: null,
      schedule: {},
    });
    render(
      <QueryClientProvider client={client}>
        <BackupPanel owner />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("archiving_media · 5%")).toBeInTheDocument();
  }, 15_000);
});
