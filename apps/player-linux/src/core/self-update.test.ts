import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  SelfUpdater,
  parseVersionCode,
  promoteAppImage,
  type SelfUpdateDeps,
} from "./self-update";
import type {
  PlayerCommand,
  UpdateMetadata,
  UpdateStatusReport,
} from "./types";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const RELEASE_ID = "11111111-1111-1111-1111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-2222-2222-222222222222";
const TEST_ARTIFACT = Buffer.alloc(4096, 0x5a);
const ARTIFACT_SHA = createHash("sha256").update(TEST_ARTIFACT).digest("hex");

function metadata(overrides: Partial<UpdateMetadata> = {}): UpdateMetadata {
  return {
    releaseId: RELEASE_ID,
    platform: "linux",
    versionCode: 2000,
    versionName: "0.2.0",
    artifactSizeBytes: 4096,
    artifactSha256: ARTIFACT_SHA,
    artifactPath: `/api/v1/player/updates/${RELEASE_ID}/artifact`,
    ...overrides,
  };
}

function command(payload: Record<string, unknown> = {}): PlayerCommand {
  return {
    id: "cmd-1",
    type: "install_player_update",
    idempotencyKey: "cmd-1",
    state: "delivered",
    createdAt: "2026-07-20T00:00:00Z",
    expiresAt: "2026-07-27T00:00:00Z",
    payload: {
      deploymentId: DEPLOYMENT_ID,
      releaseId: RELEASE_ID,
      expectedVersionCode: 2000,
      expectedArtifactSha256: ARTIFACT_SHA,
      installationMode: "install_now",
      ...payload,
    },
  };
}

function deps(overrides: Partial<SelfUpdateDeps> = {}): {
  d: SelfUpdateDeps;
  states: string[];
  reports: UpdateStatusReport[];
  restart: ReturnType<typeof vi.fn>;
  promote: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
} {
  const states: string[] = [];
  const reports: UpdateStatusReport[] = [];
  const restart = vi.fn();
  const promote = vi.fn(async () => {});
  const download = vi.fn(async () => {});
  const d: SelfUpdateDeps = {
    appImagePath: "/home/tilecast/tilecast-player.AppImage",
    stagePath: path.join(
      tmpdir(),
      `tilecast-player-update-${randomUUID()}.AppImage`,
    ),
    fetchMetadata: async () => metadata(),
    reportStatus: async (_id, body) => {
      states.push(body.state);
      reports.push(body);
    },
    download: vi.fn(async (request) => {
      await mkdir(path.dirname(request.destination), { recursive: true });
      await writeFile(request.destination, TEST_ARTIFACT, { mode: 0o600 });
      await download(request);
    }),
    buildUrl: (path) => `https://server${path}`,
    authHeaders: () => ({ Authorization: "Bearer device" }),
    promote,
    restart,
    now: () => Date.parse("2026-07-20T12:00:00Z"),
    ...overrides,
  };
  return { d, states, reports, restart, promote, download };
}

describe("parseVersionCode", () => {
  it("derives a monotonic code from semver", () => {
    expect(parseVersionCode("0.1.0")).toBe(1000);
    expect(parseVersionCode("0.2.0")).toBe(2000);
    expect(parseVersionCode("1.4.9")).toBe(1_004_009);
    expect(parseVersionCode("2.0.0-beta.1")).toBe(2_000_000);
  });
  it("returns 0 for unparseable versions", () => {
    expect(parseVersionCode("")).toBe(0);
    expect(parseVersionCode("dev")).toBe(0);
  });
});

describe("promoteAppImage", () => {
  it("atomically replaces the AppImage with executable permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tilecast-appimage-"));
    const staged = path.join(root, "player-update.AppImage");
    const installed = path.join(root, "tilecast-player.AppImage");
    try {
      await writeFile(staged, "new-appimage", { mode: 0o600 });
      await writeFile(installed, "old-appimage", { mode: 0o755 });

      await promoteAppImage(staged, installed);

      expect(await readFile(installed, "utf8")).toBe("new-appimage");
      expect((await stat(installed)).mode & 0o777).toBe(0o755);
      await expect(stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("SelfUpdater", () => {
  it("downloads, verifies, promotes, and relaunches on install_now", async () => {
    const { d, states, restart, promote, download } = deps();
    await new SelfUpdater(d).run(command());

    expect(states).toEqual([
      "downloading",
      "downloaded",
      "verifying",
      "ready",
      "installing",
      "reconnecting",
    ]);
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://server/api/v1/player/updates/${RELEASE_ID}/artifact`,
        destination: d.stagePath,
        expectedSha256: ARTIFACT_SHA,
        expectedSizeBytes: 4096,
        etag: `"sha256-${ARTIFACT_SHA}"`,
      }),
    );
    expect(promote).toHaveBeenCalledWith(d.stagePath, d.appImagePath);
    expect(restart).toHaveBeenCalledOnce();
  });

  it("preserves the resumed byte count in the initial status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tilecast-resume-"));
    const stagePath = path.join(root, "player-update.AppImage");
    try {
      await writeFile(`${stagePath}.part`, Buffer.alloc(1024));
      const { d, reports } = deps({ stagePath });

      await new SelfUpdater(d).run(
        command({ installationMode: "download_only" }),
      );

      expect(reports[0]).toMatchObject({
        state: "downloading",
        downloadedBytes: 1024,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for an in-flight progress report before advancing state", async () => {
    let now = 0;
    let releaseProgress!: () => void;
    let markProgressStarted!: () => void;
    const progressGate = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    const progressStarted = new Promise<void>((resolve) => {
      markProgressStarted = resolve;
    });
    const reports: UpdateStatusReport[] = [];
    const { d } = deps({
      now: () => now,
      reportStatus: async (_id, body) => {
        reports.push(body);
        if (body.state === "downloading" && body.downloadedBytes === 1024) {
          markProgressStarted();
          await progressGate;
        }
      },
      download: vi.fn(async (request) => {
        now = 3_000;
        await writeFile(request.destination, TEST_ARTIFACT);
        request.onProgress?.(1024);
      }),
    });

    const running = new SelfUpdater(d).run(
      command({ installationMode: "download_only" }),
    );
    await progressStarted;

    expect(reports.map((report) => report.state)).toEqual([
      "downloading",
      "downloading",
    ]);

    releaseProgress();
    await running;

    expect(reports.map((report) => report.state)).toEqual([
      "downloading",
      "downloading",
      "downloaded",
      "verifying",
      "ready",
    ]);
  });

  it("serializes shared-stage runs and releases the lock after failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tilecast-shared-update-"));
    try {
      const stagePath = path.join(root, "shared-player-update.AppImage");
      let releaseFirst!: () => void;
      let markFirstStarted!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
      });
      const firstDownload = vi.fn(async () => {
        markFirstStarted();
        await firstGate;
        throw new Error("first update failed");
      });
      const first = deps({ stagePath, download: firstDownload });
      const second = deps({ stagePath });

      const firstRun = new SelfUpdater(first.d).run(
        command({ installationMode: "download_only" }),
      );
      await firstStarted;
      const secondRun = new SelfUpdater(second.d).run(
        command({
          deploymentId: "33333333-3333-3333-3333-333333333333",
          installationMode: "download_only",
        }),
      );
      await Promise.resolve();

      expect(second.download).not.toHaveBeenCalled();

      releaseFirst();
      await Promise.all([firstRun, secondRun]);

      expect(first.states).toEqual(["downloading", "failed"]);
      expect(second.download).toHaveBeenCalledOnce();
      expect(second.states).toEqual([
        "downloading",
        "downloaded",
        "verifying",
        "ready",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages but does not restart on download_only", async () => {
    const { d, states, restart, promote } = deps();
    await new SelfUpdater(d).run(
      command({ installationMode: "download_only" }),
    );

    expect(states).toEqual(["downloading", "downloaded", "verifying", "ready"]);
    expect(promote).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("does not report a missing staged artifact as ready", async () => {
    const { d, states, restart, promote } = deps({
      download: vi.fn(async () => {
        // Simulate a downloader that returns successfully without leaving its
        // destination behind. The final gate must still reject promotion.
      }),
    });

    await new SelfUpdater(d).run(command());

    expect(states).toEqual(["downloading", "downloaded", "failed"]);
    expect(promote).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("reports failure and does not restart when not an AppImage", async () => {
    const { d, states, restart, download } = deps({ appImagePath: null });
    await new SelfUpdater(d).run(command());

    expect(states).toEqual(["failed"]);
    expect(download).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("fails without restarting when the download hash mismatches the deployment", async () => {
    const { d, states, restart, promote } = deps({
      fetchMetadata: async () => metadata({ artifactSha256: "f".repeat(64) }),
    });
    await new SelfUpdater(d).run(command());

    expect(states).toEqual(["downloading", "failed"]);
    expect(promote).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("refuses a Tilecast Edge release from the command or the metadata", async () => {
    const first = deps();
    await new SelfUpdater(first.d).run(command({ playerFamily: "edge" }));
    expect(first.states).toEqual(["failed"]);
    expect(first.promote).not.toHaveBeenCalled();

    const second = deps({
      fetchMetadata: async () => metadata({ playerFamily: "edge" }),
    });
    await new SelfUpdater(second.d).run(command());
    expect(second.states).toEqual(["downloading", "failed"]);
    expect(second.promote).not.toHaveBeenCalled();
    expect(second.restart).not.toHaveBeenCalled();
  });

  it("propagates a download failure as a failed status", async () => {
    const { d, states, restart, promote } = deps({
      download: vi.fn(async () => {
        throw new Error("sha-256 mismatch");
      }),
    });
    await new SelfUpdater(d).run(command());

    expect(states).toEqual(["downloading", "failed"]);
    expect(promote).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("installs immediately when a maintenance window has already elapsed", async () => {
    const { d, restart, promote } = deps();
    await new SelfUpdater(d).run(
      command({
        installationMode: "maintenance_window",
        maintenanceWindowStart: "2026-07-20T06:00:00Z",
      }),
    );
    expect(promote).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledOnce();
  });
});
