import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const composeFile = "deploy/docker/compose.local-dev.yml";
const composeArgs = ["compose", "-f", composeFile];
const dbPort = process.env.TILECAST_DEV_DB_PORT ?? "15432";
const localData = path.join(root, ".tilecast-dev");

function compose(args, capture = false) {
  const result = spawnSync("docker", [...composeArgs, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(" ")} failed (${result.status})`,
    );
  }
  return result.stdout ?? "";
}

function defaultValue(environment, name, value) {
  if (!environment[name]) environment[name] = value;
}

const serverEnvironment = { ...process.env };
let startedDatabase = false;
if (!serverEnvironment.TILECAST_DATABASE_URL) {
  const runningServices = compose(
    ["ps", "--status", "running", "--services"],
    true,
  )
    .split(/\r?\n/)
    .filter(Boolean);
  compose(["up", "--detach", "--wait", "postgres"]);
  startedDatabase = !runningServices.includes("postgres");
  defaultValue(
    serverEnvironment,
    "TILECAST_DATABASE_URL",
    `postgres://tilecast:tilecast-dev-only@127.0.0.1:${dbPort}/tilecast_dev?sslmode=disable`,
  );
}

defaultValue(serverEnvironment, "TILECAST_HTTP_ADDR", "127.0.0.1:8080");
defaultValue(serverEnvironment, "TILECAST_PUBLIC_URL", "http://localhost:8080");
defaultValue(serverEnvironment, "TILECAST_MDNS_ENABLED", "false");
defaultValue(
  serverEnvironment,
  "TILECAST_MEDIA_ROOT",
  path.join(localData, "media"),
);
defaultValue(
  serverEnvironment,
  "TILECAST_UPDATE_ROOT",
  path.join(localData, "updates"),
);
defaultValue(
  serverEnvironment,
  "TILECAST_BACKUP_ROOT",
  path.join(localData, "backups"),
);
defaultValue(serverEnvironment, "TILECAST_FFMPEG_PATH", "ffmpeg");
defaultValue(serverEnvironment, "TILECAST_FFPROBE_PATH", "ffprobe");

const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
const children = [
  spawn("go", ["run", "github.com/air-verse/air@v1.67.3", "-c", ".air.toml"], {
    cwd: root,
    env: serverEnvironment,
    stdio: "inherit",
    detached: process.platform !== "win32",
  }),
  spawn(process.execPath, [vite, "--host", "127.0.0.1", "--strictPort"], {
    cwd: path.join(root, "apps/dashboard"),
    env: process.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  }),
];

let stopping = false;
let exited = 0;
let resolveExited;
const allExited = new Promise((resolve) => {
  resolveExited = resolve;
});

function signalTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid)
    return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) signalTree(child, "SIGTERM");

  const forceKill = setTimeout(() => {
    for (const child of children) signalTree(child, "SIGKILL");
  }, 5000);
  forceKill.unref();
  await allExited;
  clearTimeout(forceKill);

  if (startedDatabase) {
    try {
      compose(["stop", "postgres"]);
    } catch (error) {
      console.error(
        `Could not stop the local PostgreSQL service: ${error.message}`,
      );
      process.exitCode ||= 1;
    }
  }
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(`Could not start a development process: ${error.message}`);
    void shutdown(1);
  });
  child.on("exit", (code) => {
    exited += 1;
    if (exited === children.length) resolveExited();
    if (!stopping) void shutdown(code ?? 1);
  });
}

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));
console.log("Studio: http://localhost:5173");
console.log("Server: http://localhost:8080");
if (!process.env.TILECAST_DATABASE_URL) {
  console.log(
    "Local PostgreSQL: 127.0.0.1:%s (data is kept after shutdown)",
    dbPort,
  );
}
