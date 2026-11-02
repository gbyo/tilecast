/** External Plugin API v2. Bundled Plugin API v1 remains unchanged. */
import { z } from "zod";

export const EXTERNAL_PLUGIN_API_VERSION = 2;
export const EXTERNAL_PLUGIN_RUNTIME_VERSION = 1;
export const EXTERNAL_PLUGIN_RUNTIME_CAPABILITY = "plugin.external-runtime";
export const EXTERNAL_PLUGIN_BUNDLE_PATH = "runtime/index.js";

export const externalPluginSurfaces = [
  "strip.top",
  "strip.bottom",
  "corner.top-left",
  "corner.top-right",
  "corner.bottom-left",
  "corner.bottom-right",
  "overlay",
] as const;
export const externalPluginTiers = [
  "emergency",
  "live",
  "scheduled",
  "ambient",
] as const;

export const externalPluginManifestSchema = z.strictObject({
  apiVersion: z.literal(EXTERNAL_PLUGIN_API_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  definitionVersion: z.number().int().min(1).max(1_000_000),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  capabilities: z.strictObject({ playerManifest: z.literal(true) }),
  runtime: z.strictObject({
    surfaces: z
      .array(z.enum(externalPluginSurfaces))
      .min(1)
      .max(externalPluginSurfaces.length)
      .refine(
        (values) => new Set(values).size === values.length,
        "surface declarations must be unique",
      ),
    tier: z.enum(externalPluginTiers),
  }),
});

export type ExternalPluginManifest = z.infer<
  typeof externalPluginManifestSchema
>;
export function parseExternalPluginManifest(
  value: unknown,
): ExternalPluginManifest {
  return externalPluginManifestSchema.parse(value);
}
export function externalPluginManifestJSONSchema() {
  return z.toJSONSchema(externalPluginManifestSchema, {
    target: "draft-2020-12",
  });
}
