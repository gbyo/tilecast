import { describe, expect, it, vi } from "vitest";
import {
  AutostartInstaller,
  COLD_BOOT_WINDOW_SECONDS,
  FUSE_RECOVERY_COMMAND,
  GENERATED_MARKER,
  MANAGED_PLAYER_PATH,
  UNIT_NAME,
  coldBootLaunchVerified,
  hasFuseIndependentLaunch,
  hasManagedPlayerPath,
  parseProcUptime,
  renderUnit,
  systemAutostartDeps,
  unitQuote,
  type AutostartDeps,
  type CommandOutput,
} from "./autostart";

const UNIT_DIR = "/home/kiosk/.config/systemd/user";
const UNIT_PATH = `${UNIT_DIR}/${UNIT_NAME}`;
const APP_IMAGE = "/home/kiosk/tilecast/tilecast-player.AppImage";

function output(overrides: Partial<CommandOutput> = {}): CommandOutput {
  return { code: 0, stdout: "", stderr: "", ...overrides };
}

interface Harness {
  d: AutostartDeps;
  files: Map<string, string>;
  runs: Array<[string, string[]]>;
  run: ReturnType<typeof vi.fn>;
}

/**
 * Fake device. `responses` keys are matched against the joined command line, so
 * a test overrides only the probe it cares about.
 */
function harness(
  options: {
    files?: Record<string, string>;
    responses?: Record<string, CommandOutput>;
    appImagePath?: string | null;
    environment?: Partial<AutostartDeps["environment"]>;
  } = {},
): Harness {
  const files = new Map(Object.entries(options.files ?? {}));
  const runs: Array<[string, string[]]> = [];
  const responses = options.responses ?? {};
  const run = vi.fn(async (command: string, args: string[]) => {
    runs.push([command, args]);
    const line = [command, ...args].join(" ");
    for (const [match, response] of Object.entries(responses)) {
      if (line.includes(match)) {
        return response;
      }
    }
    // Defaults: a healthy desktop session with the unit enabled once written.
    if (line.includes("show --property=Version")) return output();
    if (line.includes("is-active graphical-session.target"))
      return output({ stdout: "active\n" });
    if (line.includes("is-enabled"))
      return files.has(UNIT_PATH)
        ? output({ stdout: "enabled\n" })
        : output({ code: 1, stdout: "disabled\n" });
    if (line.includes("Linger")) return output({ stdout: "no\n" });
    return output();
  });
  return {
    files,
    runs,
    run,
    d: {
      appImagePath:
        options.appImagePath === undefined ? APP_IMAGE : options.appImagePath,
      unitDirectory: UNIT_DIR,
      userIdentifier: "1000",
      environment: {
        display: ":0",
        waylandDisplay: null,
        invocationId: null,
        dataDirectory: null,
        serverUrl: null,
        logLevel: null,
        ...options.environment,
      },
      run,
      readFile: async (path) => files.get(path) ?? null,
      writeFile: async (path, contents) => {
        files.set(path, contents);
      },
      removeFile: async (path) => {
        files.delete(path);
      },
      makeDirectory: async () => {},
    },
  };
}

describe("unitQuote", () => {
  it("leaves plain values alone and quotes anything splittable", () => {
    expect(unitQuote("/home/kiosk/player.AppImage")).toBe(
      "/home/kiosk/player.AppImage",
    );
    expect(unitQuote("/home/my kiosk/player.AppImage")).toBe(
      '"/home/my kiosk/player.AppImage"',
    );
    expect(unitQuote('DISPLAY=:0"x')).toBe('"DISPLAY=:0\\"x"');
  });

  it("drops control characters, which quoting cannot contain", () => {
    // A unit file is line-based: a newline ends the directive even inside
    // quotes, so the tail would be parsed as one of its own.
    expect(unitQuote("DISPLAY=:0\nExecStartPre=/bin/false")).toBe(
      "DISPLAY=:0ExecStartPre=/bin/false",
    );
    expect(unitQuote("TILECAST_SERVER_URL=https://a\r\nRestart=no")).toBe(
      "TILECAST_SERVER_URL=https://aRestart=no",
    );
  });
});

describe("renderUnit", () => {
  it("captures the live session rather than guessing at it", () => {
    const unit = renderUnit({
      appImagePath: APP_IMAGE,
      target: "graphical-session.target",
      environment: {
        display: null,
        waylandDisplay: "wayland-1",
        invocationId: null,
        dataDirectory: "/srv/tilecast-state",
        serverUrl: "https://signage.example.org",
        logLevel: "debug",
        extraCaCerts: "/etc/ssl/certs/ca-certificates.crt",
      },
    });
    expect(unit).toContain(GENERATED_MARKER);
    expect(unit).toContain(
      `ExecStartPre=/bin/sh -c ${unitQuote(FUSE_RECOVERY_COMMAND)}`,
    );
    expect(unit).toContain(`ExecStart=${APP_IMAGE} --appimage-extract-and-run`);
    expect(unit).toContain("Environment=WAYLAND_DISPLAY=wayland-1");
    expect(unit).not.toContain("DISPLAY=:0");
    expect(unit).toContain("Environment=TILECAST_DATA_DIR=/srv/tilecast-state");
    expect(unit).toContain(`Environment=PATH=${MANAGED_PLAYER_PATH}`);
    expect(unit).toContain(
      "Environment=TILECAST_SERVER_URL=https://signage.example.org",
    );
    expect(unit).toContain("Environment=TILECAST_LOG_LEVEL=debug");
    expect(unit).toContain(
      "Environment=NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
    );
    expect(unit).toContain("WantedBy=graphical-session.target");
    expect(unit).toContain("PartOf=graphical-session.target");
  });

  it("keeps the crash-loop directives that stop a unit latching into failed", () => {
    const unit = renderUnit({
      appImagePath: APP_IMAGE,
      target: "default.target",
      environment: {
        display: ":0",
        waylandDisplay: null,
        invocationId: null,
        dataDirectory: null,
        serverUrl: null,
        logLevel: null,
      },
    });
    // StartLimitIntervalSec is ignored under [Service] on modern systemd.
    const unitSection = unit.slice(
      unit.indexOf("[Unit]"),
      unit.indexOf("[Service]"),
    );
    expect(unitSection).toContain("StartLimitIntervalSec=0");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("findmnt -rn -o TARGET,FSTYPE");
    expect(unit).toContain("fusermount3 -uz");
    expect(unit).toContain("rmdir");
    expect(unit).not.toContain("rm -rf");
    // default.target has no session to be part of.
    expect(unit).not.toContain("PartOf=");
  });
});

describe("hasFuseIndependentLaunch", () => {
  it("recognizes only an active ExecStart with the portable runtime switch", () => {
    expect(
      hasFuseIndependentLaunch(
        `ExecStart=${APP_IMAGE} --appimage-extract-and-run`,
      ),
    ).toBe(true);
    expect(hasFuseIndependentLaunch(`ExecStart=${APP_IMAGE}`)).toBe(false);
    expect(
      hasFuseIndependentLaunch(
        `# ExecStart=${APP_IMAGE} --appimage-extract-and-run`,
      ),
    ).toBe(false);
  });
});

describe("hasManagedPlayerPath", () => {
  it("recognizes the exact managed host-tool path", () => {
    expect(
      hasManagedPlayerPath(`Environment=PATH=${MANAGED_PLAYER_PATH}`),
    ).toBe(true);
    expect(hasManagedPlayerPath("# Environment=PATH=/usr/bin:/bin")).toBe(
      false,
    );
    expect(hasManagedPlayerPath("Environment=PATH=/usr/bin:/bin")).toBe(false);
  });
});

describe("AutostartInstaller.repairLegacyGeneratedUnit", () => {
  it("rewrites a legacy generated unit without changing its target", async () => {
    const h = harness({
      files: {
        [UNIT_PATH]: `${GENERATED_MARKER}\nExecStart=${APP_IMAGE}\n[Install]\nWantedBy=default.target\n`,
      },
    });

    const repaired = await new AutostartInstaller(
      h.d,
    ).repairLegacyGeneratedUnit();

    expect(repaired).toBe(true);
    expect(h.files.get(UNIT_PATH)).toContain(
      `ExecStart=${APP_IMAGE} --appimage-extract-and-run`,
    );
    expect(h.files.get(UNIT_PATH)).toContain("WantedBy=default.target");
    expect(h.runs).toContainEqual(["systemctl", ["--user", "daemon-reload"]]);
    expect(h.runs.some(([, args]) => args.includes("enable"))).toBe(false);
  });

  it("leaves missing, current, and operator-owned units untouched", async () => {
    const current = harness({
      files: {
        [UNIT_PATH]: `${GENERATED_MARKER}\nExecStart=${APP_IMAGE} --appimage-extract-and-run\nEnvironment=PATH=${MANAGED_PLAYER_PATH}\n`,
      },
    });
    const operator = harness({
      files: { [UNIT_PATH]: `ExecStart=${APP_IMAGE}\n` },
    });
    const missing = harness();

    expect(
      await new AutostartInstaller(current.d).repairLegacyGeneratedUnit(),
    ).toBe(false);
    expect(
      await new AutostartInstaller(operator.d).repairLegacyGeneratedUnit(),
    ).toBe(false);
    expect(
      await new AutostartInstaller(missing.d).repairLegacyGeneratedUnit(),
    ).toBe(false);
    expect(current.runs).toHaveLength(0);
    expect(operator.runs).toHaveLength(0);
    expect(missing.runs).toHaveLength(0);
  });

  it("repairs a current-launch unit that predates the managed PATH", async () => {
    const h = harness({
      files: {
        [UNIT_PATH]: `${GENERATED_MARKER}\nExecStart=${APP_IMAGE} --appimage-extract-and-run\n[Install]\nWantedBy=default.target\n`,
      },
    });

    expect(await new AutostartInstaller(h.d).repairLegacyGeneratedUnit()).toBe(
      true,
    );
    expect(h.files.get(UNIT_PATH)).toContain(
      `Environment=PATH=${MANAGED_PLAYER_PATH}`,
    );
    expect(h.runs).toContainEqual(["systemctl", ["--user", "daemon-reload"]]);
  });

  it("adds host CA trust to an older generated unit", async () => {
    const h = harness({
      files: {
        [UNIT_PATH]: `${GENERATED_MARKER}\n[Service]\nExecStart=${APP_IMAGE} --appimage-extract-and-run\nEnvironment=PATH=${MANAGED_PLAYER_PATH}\nEnvironment=TILECAST_DISABLE_GPU=1\n[Install]\nWantedBy=default.target\n`,
      },
      environment: { extraCaCerts: "/etc/ssl/certs/ca-certificates.crt" },
    });

    expect(await new AutostartInstaller(h.d).repairLegacyGeneratedUnit()).toBe(
      true,
    );
    expect(h.files.get(UNIT_PATH)).toContain(
      "Environment=NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
    );
    expect(h.files.get(UNIT_PATH)).toContain("Environment=TILECAST_DISABLE_GPU=1");
  });
});

describe("AutostartInstaller.install", () => {
  it("writes and enables the unit without starting it", async () => {
    const h = harness();
    const result = await new AutostartInstaller(h.d).install();

    expect(result.success).toBe(true);
    expect(result.code).toBe("autostart_installed");
    expect(h.files.get(UNIT_PATH)).toContain(GENERATED_MARKER);
    const lines = h.runs.map(([command, args]) => [command, ...args].join(" "));
    expect(lines).toContain("systemctl --user daemon-reload");
    expect(lines).toContain(`systemctl --user enable ${UNIT_NAME}`);
    // Starting the unit would run a second player over this one.
    expect(lines.some((line) => line.includes("--now"))).toBe(false);
    expect(lines.some((line) => line.includes("start"))).toBe(false);
    expect(result.message).toContain("no duplicate was started");
    expect(result.message).toContain("next controlled restart");
  });

  it("falls back to default.target when the graphical target is not active", async () => {
    const h = harness({
      responses: {
        "is-active graphical-session.target": output({
          code: 3,
          stdout: "inactive\n",
        }),
      },
    });
    const result = await new AutostartInstaller(h.d).install();

    expect(result.success).toBe(true);
    expect(h.files.get(UNIT_PATH)).toContain("WantedBy=default.target");
    // Without linger a default.target unit does not survive logout, and the
    // operator has to hear that from the command result.
    expect(result.message).toContain("enable-linger");
  });

  it("does not claim boot launch it cannot verify", async () => {
    const h = harness();
    const result = await new AutostartInstaller(h.d).install();
    // The graphical session itself is root-owned OS setup, not ours.
    expect(result.message).toMatch(/auto-login|kiosk compositor/);
  });

  it("refuses to overwrite a unit it did not generate", async () => {
    const h = harness({
      files: { [UNIT_PATH]: "[Unit]\nDescription=Operator's own unit\n" },
    });
    const result = await new AutostartInstaller(h.d).install();

    expect(result.success).toBe(false);
    expect(result.code).toBe("autostart_conflict");
    expect(h.files.get(UNIT_PATH)).toContain("Operator's own unit");
  });

  it("reports unsupported when the player is not a managed AppImage", async () => {
    const h = harness({ appImagePath: null });
    const result = await new AutostartInstaller(h.d).install();

    expect(result.success).toBe(false);
    expect(result.code).toBe("autostart_unsupported");
    expect(h.files.has(UNIT_PATH)).toBe(false);
  });

  it("reports unsupported when there is no systemd user manager", async () => {
    const h = harness({
      responses: { "show --property=Version": output({ code: 1 }) },
    });
    const result = await new AutostartInstaller(h.d).install();

    expect(result.success).toBe(false);
    expect(result.code).toBe("autostart_unsupported");
  });

  it("fails when systemd does not report the unit as enabled afterwards", async () => {
    const h = harness({
      responses: { "is-enabled": output({ code: 1, stdout: "disabled\n" }) },
    });
    const result = await new AutostartInstaller(h.d).install();

    expect(result.success).toBe(false);
    expect(result.code).toBe("autostart_failed");
  });
});

describe("systemAutostartDeps", () => {
  it("can capture the effective state identity used by a manual launch", () => {
    const deps = systemAutostartDeps(
      {
        APPIMAGE: APP_IMAGE,
        DISPLAY: ":0",
        HOME: "/home/kiosk",
        TILECAST_SERVER_URL: "",
        NODE_EXTRA_CA_CERTS: "/srv/trust/private-ca.pem",
      },
      {
        dataDirectory: "/srv/tilecast-state",
        serverUrl: "https://signage.example.org",
      },
    );

    expect(deps.appImagePath).toBe(APP_IMAGE);
    expect(deps.environment.display).toBe(":0");
    expect(deps.environment.dataDirectory).toBe("/srv/tilecast-state");
    expect(deps.environment.serverUrl).toBe("https://signage.example.org");
    expect(deps.environment.extraCaCerts).toBe("/srv/trust/private-ca.pem");
  });
});

describe("AutostartInstaller.remove", () => {
  it("disables and deletes a generated unit without stopping the player", async () => {
    const h = harness();
    const installer = new AutostartInstaller(h.d);
    await installer.install();
    h.runs.length = 0;

    const result = await installer.remove();

    expect(result.success).toBe(true);
    expect(h.files.has(UNIT_PATH)).toBe(false);
    const lines = h.runs.map(([command, args]) => [command, ...args].join(" "));
    expect(lines).toContain(`systemctl --user disable ${UNIT_NAME}`);
    expect(lines.some((line) => line.includes("stop"))).toBe(false);
  });

  it("leaves a hand-written unit in place", async () => {
    const h = harness({
      files: { [UNIT_PATH]: "[Unit]\nDescription=Operator's own unit\n" },
    });
    const result = await new AutostartInstaller(h.d).remove();

    expect(result.success).toBe(false);
    expect(result.code).toBe("autostart_conflict");
    expect(h.files.has(UNIT_PATH)).toBe(true);
  });

  it("succeeds when nothing is installed", async () => {
    const h = harness();
    const result = await new AutostartInstaller(h.d).remove();
    expect(result.success).toBe(true);
    expect(result.code).toBe("autostart_absent");
  });
});

describe("AutostartInstaller.probe", () => {
  it("reports an installed generated unit with its target", async () => {
    const h = harness({ environment: { invocationId: "abc123" } });
    const installer = new AutostartInstaller(h.d);
    await installer.install();

    const status = await installer.probe();
    expect(status.state).toBe("installed");
    expect(status.target).toBe("graphical-session.target");
    expect(status.supervised).toBe(true);
    expect(status.detail).toBe("");
  });

  it("distinguishes a present-but-disabled unit from a missing one", async () => {
    const h = harness({
      files: { [UNIT_PATH]: `${GENERATED_MARKER}\nWantedBy=default.target\n` },
      responses: { "is-enabled": output({ code: 1, stdout: "disabled\n" }) },
    });
    const status = await new AutostartInstaller(h.d).probe();
    expect(status.state).toBe("needs_attention");
    expect(status.target).toBe("default.target");

    const empty = await new AutostartInstaller(harness().d).probe();
    expect(empty.state).toBe("not_installed");
  });

  it("flags an enabled unit that Tilecast did not write", async () => {
    const h = harness({
      files: { [UNIT_PATH]: "[Install]\nWantedBy=default.target\n" },
      responses: { "is-enabled": output({ stdout: "enabled\n" }) },
    });
    const status = await new AutostartInstaller(h.d).probe();
    expect(status.state).toBe("needs_attention");
    expect(status.detail).toContain("operator-managed");
  });

  it("does not guess how an operator-owned wrapper handles AppImages", async () => {
    const h = harness({
      files: {
        [UNIT_PATH]:
          "[Service]\nExecStart=/usr/local/bin/tilecast-launcher\n[Install]\nWantedBy=default.target\n",
      },
      responses: { "is-enabled": output({ stdout: "enabled\n" }) },
    });
    const status = await new AutostartInstaller(h.d).probe();
    expect(status.state).toBe("installed");
    expect(status.detail).toContain("not generated by Tilecast");
  });

  it("flags a legacy generated direct-launch unit", async () => {
    const h = harness({
      files: {
        [UNIT_PATH]: `${GENERATED_MARKER}\nExecStart=${APP_IMAGE}\n[Install]\nWantedBy=default.target\n`,
      },
      responses: { "is-enabled": output({ stdout: "enabled\n" }) },
    });
    const status = await new AutostartInstaller(h.d).probe();
    expect(status.state).toBe("needs_attention");
    expect(status.detail).toContain("legacy FUSE mount path");
  });

  it("reports linger state and never throws on a broken device", async () => {
    const h = harness({ responses: { Linger: output({ stdout: "yes\n" }) } });
    expect((await new AutostartInstaller(h.d).probe()).lingerEnabled).toBe(
      true,
    );
    // Named explicitly: `show-user` with no user reports the login manager's
    // own properties, which carry no Linger, so every device would read "no".
    expect(h.runs.find(([command]) => command === "loginctl")?.[1]).toEqual([
      "show-user",
      "1000",
      "--property=Linger",
      "--value",
    ]);

    const broken = harness();
    broken.run.mockRejectedValue(new Error("systemctl missing"));
    const status = await new AutostartInstaller(broken.d).probe();
    expect(status.state).toBe("unsupported");
  });
});

describe("parseProcUptime", () => {
  it("reads the first field and rejects anything unusable", () => {
    expect(parseProcUptime("3607.55 14203.11\n")).toBeCloseTo(3607.55);
    expect(parseProcUptime("")).toBeNull();
    expect(parseProcUptime("not-a-number 1\n")).toBeNull();
  });
});

describe("coldBootLaunchVerified", () => {
  it("requires both systemd supervision and proximity to boot", () => {
    expect(
      coldBootLaunchVerified({
        supervised: true,
        systemUptimeSecondsAtStart: 42,
      }),
    ).toBe(true);
    // Started by hand well into an existing session.
    expect(
      coldBootLaunchVerified({
        supervised: true,
        systemUptimeSecondsAtStart: COLD_BOOT_WINDOW_SECONDS + 1,
      }),
    ).toBe(false);
    // A developer run that happens to be early after boot is not boot launch.
    expect(
      coldBootLaunchVerified({
        supervised: false,
        systemUptimeSecondsAtStart: 5,
      }),
    ).toBe(false);
    expect(
      coldBootLaunchVerified({
        supervised: true,
        systemUptimeSecondsAtStart: null,
      }),
    ).toBe(false);
  });
});
