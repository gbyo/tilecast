import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import manifest from "../testdata/manifests/valid/v3-complete.json";
import { parsePluginManifest } from "../src/manifest";
import { generatedFragment } from "../tools/pluginctl/hosted-api";

it("validates instance responses and exposes secret states without write fields", () => {
  const parsed = parsePluginManifest(manifest);
  if (parsed.apiVersion !== 3) throw new Error("expected API 3 manifest");
  parsed.instances[0]!.fields.push({
    key: "token",
    label: "Token",
    control: "secret",
  });
  const { components } = generatedFragment(parsed) as {
    components: { schemas: Record<string, object> };
  };
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validate = ajv.compile({
    ...components.schemas["RoomSign"],
    components,
  });
  const response = {
    id: "f0d0452e-3e21-4ed2-b311-51d77dc76ff3",
    kind: "sign",
    name: "Lobby",
    enabled: true,
    priority: 1,
    title: "Welcome",
    targetScope: "all",
    targetIds: [],
    schedule: {
      timezone: "UTC",
      days: [1],
      startTime: "08:00",
      endTime: "17:00",
    },
    revision: 1,
    secrets: { token: "set" },
    createdAt: "2026-06-01T12:00:00Z",
    updatedAt: "2026-06-01T12:00:00Z",
  };
  expect(validate(response), JSON.stringify(validate.errors)).toBe(true);
  expect(validate({ ...response, secrets: { token: "value" } })).toBe(false);
  expect(validate({ ...response, clearSecrets: ["token"] })).toBe(false);
  expect(validate({ ...response, expectedRevision: 1 })).toBe(false);
});
