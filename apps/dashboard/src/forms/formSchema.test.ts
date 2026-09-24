import { describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import type { FormDataSource, FormFieldControl } from "../api/types";
import {
  CONTROLS,
  controlsWithOutputType,
  newField,
  outputTypeFor,
  publishedOutputKeys,
} from "./formSchema";

const t = i18n.getFixedT("en", "forms");

describe("formSchema", () => {
  it("supports exactly the backend controls", () => {
    const controls = CONTROLS.map((c) => c.control).sort();
    expect(controls).toEqual(
      (
        [
          "boolean",
          "date",
          "datetime",
          "help_text",
          "image",
          "integer",
          "long_text",
          "multi_select",
          "number",
          "section",
          "select",
          "short_text",
          "url",
        ] as FormFieldControl[]
      ).sort(),
    );
  });

  it("maps controls to output types with presentation controls producing none", () => {
    expect(outputTypeFor("short_text")).toBe("text");
    expect(outputTypeFor("integer")).toBe("integer");
    expect(outputTypeFor("image")).toBe("asset");
    expect(outputTypeFor("section")).toBeNull();
    expect(outputTypeFor("help_text")).toBeNull();
  });

  it("creates fields with unique keys and option defaults", () => {
    const first = newField("select", ["title"], t);
    expect(first.control).toBe("select");
    expect(first.options?.length).toBeGreaterThan(0);
    const second = newField("short_text", [first.key, "title"], t);
    expect(second.key).not.toBe(first.key);
  });

  it("derives published output keys and compatible controls", () => {
    const form = {
      publishedRevision: {
        schema: {
          fields: [
            { key: "title", label: "Title", control: "short_text" },
            { key: "intro", label: "Intro", control: "section" },
          ],
        },
      },
    } as unknown as FormDataSource;
    const keys = publishedOutputKeys(form);
    expect(keys.get("title")).toBe("text");
    expect(keys.has("intro")).toBe(false); // presentation-only
    expect(controlsWithOutputType("text")).toContain("select");
    expect(controlsWithOutputType("text")).not.toContain("number");
  });
});
