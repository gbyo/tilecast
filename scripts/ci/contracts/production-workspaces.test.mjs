import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const dockerfile = readFileSync("deploy/docker/Dockerfile", "utf8");
const workspaces = new Map();
for (const parent of ["apps", "packages"]) {
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = `${parent}/${entry.name}`;
    try {
      const manifest = JSON.parse(readFileSync(`${path}/package.json`, "utf8"));
      workspaces.set(manifest.name, { path, manifest });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function dependencies(name, found = new Set()) {
  if (found.has(name)) return found;
  found.add(name);
  const { manifest } = workspaces.get(name);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (workspaces.has(dependency)) dependencies(dependency, found);
  }
  return found;
}

for (const [name, stage] of [
  ["@tilecast/dashboard", "dashboard-build"],
  ["@tilecast/player-web", "player-web-build"],
]) {
  test(`${stage} copies every runtime workspace dependency`, () => {
    const depsStage = dockerfile.split("FROM node-deps AS dashboard-build")[0];
    const buildStage = dockerfile
      .split(`FROM node-deps AS ${stage}\n`)[1]
      .split("\nFROM ")[0];
    for (const dependency of dependencies(name)) {
      const { path } = workspaces.get(dependency);
      assert.ok(
        depsStage.includes(`COPY ${path}/package.json ${path}/package.json`),
        `${dependency} manifest is missing before npm ci`,
      );
      // CSS-only workspaces can be copied in the dependency stage.
      assert.ok(
        buildStage.includes(`COPY ${path} ${path}\n`) ||
          buildStage.includes(`COPY ${path}/generated ${path}/generated\n`) ||
          depsStage.includes(`COPY ${path}/*.css ${path}/`),
        `${dependency} source is missing in ${stage}`,
      );
    }
  });
}
