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

it("generates a bounded, unique contract surface at the instance-kind limit", async () => {
  const { default: sixteen } = await import(
    "../testdata/manifests/valid/v3-sixteen-kinds.json"
  );
  const { MAX_INSTANCE_KINDS } = await import("../src/manifest");
  const { generatedAutomation } = await import(
    "../tools/pluginctl/hosted-api"
  );
  const parsed = parsePluginManifest(sixteen);
  if (parsed.apiVersion !== 3) throw new Error("expected API 3 manifest");
  expect(parsed.instances).toHaveLength(MAX_INSTANCE_KINDS);
  expect(MAX_INSTANCE_KINDS).toBe(16);

  const fragment = generatedFragment(parsed) as {
    paths: Record<string, Record<string, { operationId: string }>>;
  };
  const operationIds = Object.values(fragment.paths).flatMap((methods) =>
    Object.values(methods).map((operation) => operation.operationId),
  );
  // Settings operations plus five CRUD operations for each kind, all unique.
  expect(new Set(operationIds).size).toBe(operationIds.length);
  for (let index = 0; index < 16; index += 1) {
    expect(
      operationIds.filter((id) => id.toLowerCase().includes(`k${index}`))
        .length,
    ).toBeGreaterThanOrEqual(5);
  }

  const automation = generatedAutomation(parsed);
  expect(automation).toHaveLength(16 * 5);
  const commands = automation.map((operation) => JSON.stringify(operation));
  expect(new Set(commands).size).toBe(commands.length);
});
