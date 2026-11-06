import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { check, scaffold } from "../tools/datactl/main.ts";
import { discover } from "../tools/datactl/repo.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "datactl-"));
  roots.push(root);
  mkdirSync(join(root, "data-sources"));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("datactl scaffold and check", () => {
  for (const adapter of [
    "manual_object",
    "manual_records",
    "http_records",
  ] as const) {
    it(`scaffolds ${adapter} as requiring manifest v13`, () => {
      const root = tempRoot();
      scaffold(root, { name: "sample", displayName: "Sample", adapter });
      expect(check(discover(root))).toEqual([]);
      const manifest = JSON.parse(
        readFileSync(
          join(root, "data-sources/sample/tilecast.datasource.json"),
          "utf8",
        ),
      );
      expect(manifest.requiresManifestV13).toBe(true);
    });
  }

  it("rejects a module that omits the v13 requirement", () => {
    const root = tempRoot();
    scaffold(root, {
      name: "sample",
      displayName: "Sample",
      adapter: "manual_records",
    });
    const path = join(root, "data-sources/sample/tilecast.datasource.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    delete manifest.requiresManifestV13;
    writeFileSync(path, JSON.stringify(manifest));
    const problems = check(discover(root));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("requiresManifestV13");
  });
});
