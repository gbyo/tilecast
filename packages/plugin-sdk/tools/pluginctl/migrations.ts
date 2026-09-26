/**
 * One global Goose migration sequence. Core migrations live in the server;
 * a plugin's migrations live in its own directory. Both share one version
 * space, so LatestMigrationVersion, MigrateTo, and exact-version backup
 * restore keep working unchanged.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Problem, Repo } from "./repo.ts";

export const CORE_MIGRATIONS = "apps/server/internal/database/migrations";
export const MIGRATION_LOCK =
  "apps/server/internal/database/migrations.lock.json";

const filePattern = /^(\d{5})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  version: number;
  file: string;
  /** "core" or the owning plugin's ID. */
  owner: string;
  /** Repository-relative path. */
  path: string;
  sha256: string;
}

export function collectMigrations(repo: Repo): {
  migrations: Migration[];
  problems: Problem[];
} {
  const problems: Problem[] = [];
  const migrations: Migration[] = [];
  const read = (dir: string, owner: string, plugin?: string) => {
    for (const file of readdirSync(dir).sort()) {
      const path = relative(repo.root, join(dir, file));
      if (file === ".gitkeep") continue;
      const match = filePattern.exec(file);
      if (!match) {
        problems.push({
          plugin,
          file: path,
          message: "migration files are named NNNNN_snake_case.sql",
        });
        continue;
      }
      const text = readFileSync(join(dir, file));
      const body = text.toString("utf8");
      if (
        !/^-- \+goose Up\b/m.test(body) ||
        !/^-- \+goose Down\b/m.test(body)
      ) {
        problems.push({
          plugin,
          file: path,
          message: "a migration needs -- +goose Up and -- +goose Down sections",
        });
      }
      migrations.push({
        version: Number(match[1]),
        file,
        owner,
        path,
        sha256: createHash("sha256").update(text).digest("hex"),
      });
    }
  };
  read(join(repo.root, CORE_MIGRATIONS), "core");
  for (const plugin of repo.plugins) {
    const declared = plugin.manifest.migrations;
    const conventional = join(plugin.path, "migrations");
    if (!declared) {
      if (existsSync(conventional)) {
        problems.push({
          plugin: plugin.manifest.id,
          file: relative(repo.root, conventional),
          message:
            'migrations/ exists but the manifest does not declare "migrations"',
        });
      }
      continue;
    }
    const dir = join(plugin.path, declared);
    if (!existsSync(dir)) {
      problems.push({
        plugin: plugin.manifest.id,
        message: `declared migrations directory ${declared} does not exist`,
      });
      continue;
    }
    read(dir, plugin.manifest.id, plugin.manifest.id);
  }
  migrations.sort(
    (a, b) => a.version - b.version || a.file.localeCompare(b.file),
  );
  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1]!;
    const current = migrations[index]!;
    if (previous.version === current.version) {
      problems.push({
        file: current.path,
        message: `migration version ${current.version} is also used by ${previous.path}; reserve a new one with npm run plugins:migration`,
      });
    }
  }
  return { migrations, problems };
}

export function nextVersion(migrations: Migration[]): string {
  const latest = migrations.reduce(
    (max, item) => Math.max(max, item.version),
    0,
  );
  return String(latest + 1).padStart(5, "0");
}

/**
 * The lock records every migration's version, owner, and content hash. It is
 * regenerated, never hand-edited: a changed hash for an old version shows up
 * in review as an edited shipped migration, and the server test compares the
 * embedded catalog with it so a plugin's migrations cannot silently fall out
 * of the binary.
 */
export function migrationLock(migrations: Migration[]): string {
  return (
    JSON.stringify(
      migrations.map(({ version, file, owner, sha256 }) => ({
        version,
        file,
        owner,
        sha256,
      })),
      null,
      2,
    ) + "\n"
  );
}
