/**
 * Serves the shared Tilecast Player Runtime at tilecast://runtime/.
 *
 * Every host loads the same built runtime artifact from the same trusted
 * origin. Only files the artifact's own manifest lists are served, each path is
 * checked against a fixed grammar before it is looked up, and nothing outside
 * the runtime directory is reachable: no traversal, no query-controlled path,
 * no directory listing. The scheme gets only the privileges a document origin
 * needs (standard, secure); it does not bypass the page's CSP and it does not
 * expose tcmedia: or the filesystem.
 */
import { promises as fs } from "fs";
import * as path from "path";

export const RUNTIME_SCHEME = "tilecast";
export const RUNTIME_HOST = "runtime";
export const RUNTIME_ENTRY_URL = `${RUNTIME_SCHEME}://${RUNTIME_HOST}/index.html`;

/** Registered before the app is ready (protocol.registerSchemesAsPrivileged). */
export const RUNTIME_SCHEME_PRIVILEGES = {
  scheme: RUNTIME_SCHEME,
  privileges: { standard: true, secure: true },
} as const;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

/** A runtime-relative path, or null when the URL is not a runtime file. */
export function runtimePath(requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${RUNTIME_SCHEME}:` || url.hostname !== RUNTIME_HOST) {
    return null;
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    return null;
  }
  // The URL parser resolves dot segments, including encoded ones. A runtime
  // file name is exactly what was requested: anything the parser rewrote
  // (%2e, "..", a backslash) is refused rather than normalized.
  const prefix = `${RUNTIME_SCHEME}://${RUNTIME_HOST}`;
  if (requestUrl.slice(prefix.length) !== url.pathname) return null;
  const segments = url.pathname.replace(/^\//, "").split("/");
  if (segments.length < 1 || segments.length > 2) return null;
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment.includes("..")) return null;
  }
  return segments.join("/");
}

export interface RuntimeFiles {
  directory: string;
  /** Published path → expected size, from runtime-manifest.json. */
  files: Map<string, number>;
  version: string;
}

export async function loadRuntimeFiles(
  directory: string,
): Promise<RuntimeFiles> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, "runtime-manifest.json"), "utf8"),
  ) as { version?: string; files?: { path: string; bytes: number }[] };
  const files = new Map<string, number>();
  for (const entry of manifest.files ?? []) {
    if (runtimePath(`${RUNTIME_SCHEME}://${RUNTIME_HOST}/${entry.path}`)) {
      files.set(entry.path, entry.bytes);
    }
  }
  if (!files.has("index.html") || !files.has("runtime.js")) {
    throw new Error("runtime artifact is incomplete");
  }
  return { directory, files, version: String(manifest.version ?? "unknown") };
}

export async function serveRuntimeRequest(
  runtime: RuntimeFiles,
  requestUrl: string,
): Promise<Response> {
  const relative = runtimePath(requestUrl);
  if (!relative || !runtime.files.has(relative)) {
    return new Response("not found", { status: 404 });
  }
  const file = path.join(runtime.directory, ...relative.split("/"));
  // Belt and braces: the grammar already excludes traversal.
  if (path.relative(runtime.directory, file).startsWith("..")) {
    return new Response("not found", { status: 404 });
  }
  let body: Buffer;
  try {
    body = await fs.readFile(file);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (body.byteLength !== runtime.files.get(relative)) {
    return new Response("runtime file does not match its manifest", {
      status: 500,
    });
  }
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type":
        CONTENT_TYPES[path.extname(relative)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
