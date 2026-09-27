/**
 * Widget module discovery for widgetctl. A Widget is a directory below
 * widgets/ that contains a tilecast.widget.json; nothing else registers it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  widgetDirPattern,
  widgetFixtureSchema,
  widgetManifestSchema,
  type WidgetFixture,
  type WidgetManifest,
} from "../../src/manifest.ts";

export const MANIFEST_FILE = "tilecast.widget.json";

/** Tooling directories below widgets/ that are not Widget modules. */
export const RESERVED_DIRS = new Set(["visual"]);

export interface Problem {
  widget?: string;
  file?: string;
  message: string;
}

export interface DiscoveredWidget {
  dir: string;
  path: string;
  manifest: WidgetManifest;
  fixtures: { file: string; fixture: WidgetFixture }[];
}

export interface Repo {
  root: string;
  widgetsDir: string;
  widgets: DiscoveredWidget[];
  problems: Problem[];
}

export function repoRoot(from: string = import.meta.dirname): string {
  return resolve(from, "..", "..", "..", "..");
}

function readJSON(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function discover(root: string): Repo {
  const widgetsDir = join(root, "widgets");
  const problems: Problem[] = [];
  const widgets: DiscoveredWidget[] = [];
  const entries = existsSync(widgetsDir)
    ? readdirSync(widgetsDir).filter((name) =>
        statSync(join(widgetsDir, name)).isDirectory(),
      )
    : [];
  for (const dir of entries.sort()) {
    if (dir === "node_modules" || dir.startsWith(".") || RESERVED_DIRS.has(dir))
      continue;
    const path = join(widgetsDir, dir);
    const manifestPath = join(path, MANIFEST_FILE);
    const file = relative(root, manifestPath);
    if (!widgetDirPattern.test(dir)) {
      problems.push({ widget: dir, message: "directory name is invalid" });
      continue;
    }
    if (!existsSync(manifestPath)) {
      problems.push({
        widget: dir,
        message: `directory has no ${MANIFEST_FILE}`,
      });
      continue;
    }
    let raw: unknown;
    try {
      raw = readJSON(manifestPath);
    } catch (error) {
      problems.push({
        widget: dir,
        file,
        message: `invalid JSON: ${String(error)}`,
      });
      continue;
    }
    const parsed = widgetManifestSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push({
          widget: dir,
          file,
          message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        });
      }
      continue;
    }
    const fixtures: DiscoveredWidget["fixtures"] = [];
    const fixtureDir = join(path, "fixtures");
    for (const name of existsSync(fixtureDir)
      ? readdirSync(fixtureDir)
          .filter((n) => n.endsWith(".json"))
          .sort()
      : []) {
      const fixtureFile = relative(root, join(fixtureDir, name));
      try {
        const fixture = widgetFixtureSchema.safeParse(
          readJSON(join(fixtureDir, name)),
        );
        if (fixture.success)
          fixtures.push({ file: fixtureFile, fixture: fixture.data });
        else
          for (const issue of fixture.error.issues)
            problems.push({
              widget: dir,
              file: fixtureFile,
              message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
            });
      } catch (error) {
        problems.push({
          widget: dir,
          file: fixtureFile,
          message: `invalid JSON: ${String(error)}`,
        });
      }
    }
    widgets.push({ dir, path, manifest: parsed.data, fixtures });
  }
  return { root, widgetsDir, widgets, problems };
}
