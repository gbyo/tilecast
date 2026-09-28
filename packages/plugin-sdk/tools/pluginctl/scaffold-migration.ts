import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  collectMigrations,
  CORE_MIGRATIONS,
  nextVersion,
} from "./migrations.ts";
import type { Repo } from "./repo.ts";

/**
 * Reserve the next version in the one global sequence and create the file in
 * its owner's directory. Two branches that reserve the same number both pass
 * alone; `plugins:check` fails once they meet, and the later one reserves
 * again.
 */
export function createMigration(
  repo: Repo,
  owner: string,
  name: string,
): string {
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(name)) {
    throw new Error("migration name must be snake_case");
  }
  let dir: string;
  if (owner === "core") {
    dir = join(repo.root, CORE_MIGRATIONS);
  } else {
    const plugin = repo.plugins.find(
      (candidate) => candidate.manifest.id === owner,
    );
    if (!plugin) throw new Error(`no plugin with id ${owner}`);
    if (!plugin.manifest.migrations) {
      throw new Error(
        `${owner} does not declare "migrations": add "migrations": "./migrations" to its manifest and //go:embed migrations/*.sql to ${plugin.manifest.server?.entrypoint ?? "plugin.go"}`,
      );
    }
    dir = join(plugin.path, plugin.manifest.migrations);
  }
  const version = nextVersion(collectMigrations(repo).migrations);
  const path = join(dir, `${version}_${name}.sql`);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    "-- +goose Up\n-- +goose StatementBegin\n\n-- +goose StatementEnd\n\n-- +goose Down\n-- +goose StatementBegin\n\n-- +goose StatementEnd\n",
  );
  return relative(repo.root, path);
}
