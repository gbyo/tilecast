import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  loadRuntimeFiles,
  runtimePath,
  serveRuntimeRequest,
} from "./runtime-protocol";

function artifact(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-runtime-"));
  mkdirSync(path.join(dir, "fonts"));
  const files: Record<string, string> = {
    "index.html": "<!doctype html>",
    "runtime.js": "void 0;",
    "fonts/ui.woff2": "font",
  };
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body);
  }
  writeFileSync(path.join(dir, "secret.txt"), "not listed");
  writeFileSync(
    path.join(dir, "runtime-manifest.json"),
    JSON.stringify({
      version: "9.9.9",
      files: Object.entries(files).map(([name, body]) => ({
        path: name,
        bytes: Buffer.byteLength(body),
      })),
    }),
  );
  return dir;
}

describe("tilecast://runtime/ protocol", () => {
  it("accepts only runtime file names", () => {
    expect(runtimePath("tilecast://runtime/index.html")).toBe("index.html");
    expect(runtimePath("tilecast://runtime/fonts/ui.woff2")).toBe(
      "fonts/ui.woff2",
    );
    for (const url of [
      "tilecast://runtime/",
      "tilecast://runtime/a/b/c.js",
      "tilecast://runtime/%2e%2e/identity",
      "tilecast://runtime/index.html?x=1",
      "tilecast://runtime/index.html#x",
      "tilecast://other/index.html",
      "tcmedia://runtime/index.html",
      "tilecast://user@runtime/index.html",
      "tilecast://runtime/..%2fsecret",
      "not a url",
    ]) {
      expect(runtimePath(url), url).toBeNull();
    }
  });

  it("serves listed files and nothing else", async () => {
    const files = await loadRuntimeFiles(artifact());
    expect(files.version).toBe("9.9.9");
    const index = await serveRuntimeRequest(
      files,
      "tilecast://runtime/index.html",
    );
    expect(index.status).toBe(200);
    expect(index.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const font = await serveRuntimeRequest(
      files,
      "tilecast://runtime/fonts/ui.woff2",
    );
    expect(font.headers.get("Content-Type")).toBe("font/woff2");
    for (const url of [
      "tilecast://runtime/secret.txt",
      "tilecast://runtime/runtime-manifest.json",
      "tilecast://runtime/../../etc/passwd",
    ]) {
      expect((await serveRuntimeRequest(files, url)).status, url).toBe(404);
    }
  });

  it("refuses an incomplete artifact", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tc-runtime-"));
    writeFileSync(
      path.join(dir, "runtime-manifest.json"),
      JSON.stringify({ files: [{ path: "index.html", bytes: 1 }] }),
    );
    await expect(loadRuntimeFiles(dir)).rejects.toThrow(/incomplete/);
  });

  it("refuses a file that no longer matches its manifest", async () => {
    const dir = artifact();
    const files = await loadRuntimeFiles(dir);
    writeFileSync(path.join(dir, "runtime.js"), "tampered with");
    const response = await serveRuntimeRequest(
      files,
      "tilecast://runtime/runtime.js",
    );
    expect(response.status).toBe(500);
  });
});
