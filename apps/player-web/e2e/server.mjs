// Real Go API and isolated PostgreSQL, behind a temporary local HTTPS origin.
// Certificates, database and media are generated for this run and removed.
import { createServer } from "node:https";
import { request as proxyRequest } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "tilecast-browser-e2e-"));
const dbName = `tilecast_browser_${randomUUID().replaceAll("-", "")}`;
const maintenance =
  process.env.TEST_DATABASE_URL ??
  "postgres:///postgres?host=/tmp&sslmode=disable";
const database = new URL(maintenance);
database.pathname = `/${dbName}`;
const origin = "https://localhost:18981";
let backend;
let frontend;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  frontend?.close();
  if (backend && backend.exitCode === null) {
    backend.kill("SIGTERM");
    await new Promise((resolve) => {
      backend.once("exit", resolve);
      setTimeout(resolve, 5000);
    });
  }
  execFileSync(
    "dropdb",
    ["--if-exists", "--force", "--maintenance-db", maintenance, dbName],
    { stdio: "ignore" },
  );
  await rm(temporary, { recursive: true, force: true });
}
process.on("SIGTERM", () => {
  void cleanup().then(() => process.exit(0));
});
process.on("SIGINT", () => {
  void cleanup().then(() => process.exit(0));
});
try {
  execFileSync("createdb", ["--maintenance-db", maintenance, dbName], {
    stdio: "ignore",
  });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(temporary, "key.pem"),
      "-out",
      join(temporary, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const embed = join(root, "server/internal/web/player-static");
  const fallback = await readFile(join(embed, "index.html"));
  try {
    await cp(join(root, "player-web/dist"), embed, { recursive: true });
    execFileSync(
      "go",
      [
        "build",
        "-o",
        join(temporary, "tilecast-server"),
        "./cmd/tilecast-server",
      ],
      { cwd: join(root, "server"), stdio: "inherit" },
    );
  } finally {
    await writeFile(join(embed, "index.html"), fallback);
  }
  backend = spawn(join(temporary, "tilecast-server"), [], {
    cwd: join(root, "server"),
    env: {
      ...process.env,
      TILECAST_ENV: "development",
      TILECAST_HTTP_ADDR: "127.0.0.1:18982",
      TILECAST_DATABASE_URL: database.toString(),
      TILECAST_PUBLIC_URL: origin,
      TILECAST_COOKIE_SECURE: "true",
      TILECAST_MDNS_ENABLED: "false",
      TILECAST_FFMPEG_PATH: execFileSync("which", ["ffmpeg"], {
        encoding: "utf8",
      }).trim(),
      TILECAST_FFPROBE_PATH: execFileSync("which", ["ffprobe"], {
        encoding: "utf8",
      }).trim(),
      TILECAST_MEDIA_ROOT: join(temporary, "media"),
      TILECAST_UPDATE_ROOT: join(temporary, "updates"),
      TILECAST_BACKUP_ROOT: join(temporary, "backups"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logBuffer = "";
  backend.stdout.on("data", (chunk) => {
    logBuffer += chunk.toString();
    const lines = logBuffer.split("\n");
    logBuffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        if (JSON.parse(line).level === "ERROR")
          process.stderr.write(line + "\n");
      } catch {
        /* Startup output is not a request record. */
      }
    }
  });
  backend.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n"))
      if (line.includes("ERROR")) process.stderr.write(line + "\n");
  });
  backend.once("exit", (code) => {
    if (!cleaned && code !== 0)
      void cleanup().then(() => process.exit(code ?? 1));
  });
  frontend = createServer(
    {
      key: await readFile(join(temporary, "key.pem")),
      cert: await readFile(join(temporary, "cert.pem")),
    },
    (incoming, outgoing) => {
      const forwarded = proxyRequest(
        {
          hostname: "127.0.0.1",
          port: 18982,
          path: incoming.url,
          method: incoming.method,
          headers: { ...incoming.headers, host: "localhost:18981" },
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      forwarded.on("error", () => {
        outgoing.writeHead(503);
        outgoing.end();
      });
      incoming.pipe(forwarded);
    },
  );
  frontend.on("upgrade", (incoming, socket, head) => {
    const forwarded = proxyRequest({
      hostname: "127.0.0.1",
      port: 18982,
      path: incoming.url,
      headers: { ...incoming.headers, host: "localhost:18981" },
    });
    forwarded.on("upgrade", (response, upstream, upstreamHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    forwarded.on("error", () => socket.destroy());
    forwarded.end();
  });
  frontend.listen(18981, "localhost");
} catch (error) {
  await cleanup();
  throw error;
}
