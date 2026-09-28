import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  checkDerivedConformance,
  checkFragmentOperationIds,
} from "../tools/pluginctl/supported.ts";

function documentWithDescription(description: string) {
  return YAML.parseDocument(`openapi: 3.1.0
info: { title: Test, version: "1" }
paths:
  /api/v1/example:
    get:
      operationId: getExample
      description: ${JSON.stringify(description)}
      responses:
        "200": { description: ok }
components: {}
`);
}

describe("pluginctl supported contract checks", () => {
  it("requires an explicit leading Public. marker", () => {
    const privateProblems = checkDerivedConformance(
      documentWithDescription("This endpoint is not public."),
    );
    expect(
      privateProblems.some((problem) =>
        problem.message.includes(
          "must document its authentication requirement or declare itself public",
        ),
      ),
    ).toBe(true);

    const publicProblems = checkDerivedConformance(
      documentWithDescription("Public. No authentication is required."),
    );
    expect(
      publicProblems.some((problem) =>
        problem.message.includes(
          "must document its authentication requirement or declare itself public",
        ),
      ),
    ).toBe(false);
  });

  it("reports YAML document parse errors in plugin fragments", () => {
    expect(
      checkFragmentOperationIds([
        {
          plugin: "broken",
          file: "plugins/broken/api/openapi.yaml",
          text: "openapi: [",
        },
      ]),
    ).toContainEqual({
      plugin: "broken",
      file: "plugins/broken/api/openapi.yaml",
      message: "OpenAPI fragment does not parse",
    });
  });
});
