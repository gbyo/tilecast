/**
 * Regenerate the portable package-manifest JSON Schema from the Zod source.
 * Run with `npm run generate`; `make generate` keeps the checked-in copy
 * current and `make generated-check` fails on drift.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { packageManifestJSONSchema } from "../src/manifest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "schema", "tilecast-package.schema.json");
const options = (await prettier.resolveConfig(path)) ?? {};
const text = await prettier.format(
  JSON.stringify(packageManifestJSONSchema()),
  { ...options, filepath: path },
);
writeFileSync(path, text);
console.log(`wrote ${path}`);
