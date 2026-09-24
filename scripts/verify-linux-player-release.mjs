#!/usr/bin/env node

import { extractFile } from "@electron/asar";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`Missing required ${name} argument.`);
  }
  return path.resolve(process.argv[index + 1]);
}

function readJSON(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function versionCode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new Error(`Linux player version '${version}' is not semantic.`);
  }
  return (
    Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3])
  );
}

function requireEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}.`);
  }
}

const appImage = option("--appimage");
const packageFile = option("--package");
const manifestFile = option("--manifest");
const packageMetadata = readJSON(packageFile);
const require = createRequire(import.meta.url);
const builderConfig = require(
  path.join(path.dirname(packageFile), "electron-builder.config.cjs"),
);
const manifest = readJSON(manifestFile);
const expectedVersion = String(packageMetadata.version ?? "");
const expectedVersionCode = versionCode(expectedVersion);
const extractionRoot = mkdtempSync(
  path.join(tmpdir(), "tilecast-linux-appimage-"),
);

try {
  execFileSync(appImage, ["--appimage-extract"], {
    cwd: extractionRoot,
    stdio: ["ignore", "ignore", "inherit"],
  });

  const asarPath = path.join(
    extractionRoot,
    "squashfs-root",
    "resources",
    "app.asar",
  );
  const packagedMetadata = JSON.parse(
    extractFile(asarPath, "package.json").toString("utf8"),
  );
  const packagedVersion = String(packagedMetadata.version ?? "");
  // The display is the shared Player Runtime; a package without its built
  // artifact would boot to a bridge error on every screen.
  const runtimeRoot = "node_modules/@tilecast/player-runtime/dist/runtime";
  const runtimeManifest = JSON.parse(
    extractFile(asarPath, `${runtimeRoot}/runtime-manifest.json`).toString(
      "utf8",
    ),
  );
  for (const entry of runtimeManifest.files ?? []) {
    const bytes = extractFile(asarPath, `${runtimeRoot}/${entry.path}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== entry.sha256) {
      throw new Error(
        `Packaged runtime file ${entry.path} does not match its manifest.`,
      );
    }
  }
  console.log(
    `Packaged Player Runtime:   ${runtimeManifest.version} (${runtimeManifest.files.length} files verified)`,
  );
  const manifestVersion = String(manifest.versionName ?? "");
  const artifact = readFileSync(appImage);
  const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
  const artifactSize = artifact.byteLength;

  console.log(`Expected packaged version: ${expectedVersion}`);
  console.log(`Actual packaged version:   ${packagedVersion}`);
  console.log(`Linux package version:     ${expectedVersion}`);
  console.log(`Manifest version:          ${manifestVersion}`);
  console.log(`Packaged AppImage version: ${packagedVersion}`);
  console.log(`Version code:              ${manifest.versionCode}`);

  requireEqual("Packaged AppImage version", packagedVersion, expectedVersion);
  requireEqual("Manifest version", manifestVersion, expectedVersion);
  requireEqual(
    "Manifest version code",
    manifest.versionCode,
    expectedVersionCode,
  );
  requireEqual("Manifest platform", manifest.platform, "linux");
  requireEqual("Manifest product", manifest.product, "tilecast-player");
  requireEqual("AppImage toolset", builderConfig.toolsets?.appimage, "1.0.3");
  requireEqual(
    "Manifest artifact SHA-256",
    manifest.artifactSha256,
    artifactSha256,
  );
  requireEqual(
    "Manifest artifact size",
    manifest.artifactSizeBytes,
    artifactSize,
  );
} finally {
  rmSync(extractionRoot, { recursive: true, force: true });
}
