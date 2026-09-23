import { describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import type { FormSchema } from "../api/types";
import {
  formValuesToPayload,
  localDateTimeToRfc3339,
  recordValuesToForm,
  rfc3339ToLocalDateTime,
  validateSubmission,
} from "./formValues";

const t = i18n.getFixedT("en", "forms");

const datetimeSchema: FormSchema = {
  fields: [{ key: "startAt", label: "Start", control: "datetime" }],
};

describe("datetime round-trip", () => {
  it("converts a datetime-local value to RFC 3339 and back to the same local value", () => {
    // A wall-clock value the user typed into a datetime-local input.
    const local = "2026-07-21T14:30";
    const rfc = localDateTimeToRfc3339(local);
    // RFC 3339 with a timezone designator (UTC Z after normalization).
    expect(rfc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    // Converting back yields the original local wall-clock value (timezone-aware round trip).
    expect(rfc3339ToLocalDateTime(rfc)).toBe(local);
  });

  it("round-trips a datetime field through record<->form conversions", () => {
    const local = "2026-12-31T23:59";
    const payload = formValuesToPayload(datetimeSchema, { startAt: local });
    // The payload carries RFC 3339, not the raw local string the server would reject.
    expect(typeof payload.startAt).toBe("string");
    expect(payload.startAt).not.toBe(local);
    // Loading that stored value back yields the original local input value.
    const form = recordValuesToForm(datetimeSchema, {
      startAt: payload.startAt as string,
    });
    expect(form.startAt).toBe(local);
  });

  it("treats empty and invalid datetimes as empty", () => {
    expect(localDateTimeToRfc3339("")).toBe("");
    expect(rfc3339ToLocalDateTime("")).toBe("");
    expect(rfc3339ToLocalDateTime("not-a-date")).toBe("");
    expect(formValuesToPayload(datetimeSchema, { startAt: "" })).toEqual({});
  });
});

describe("validateSubmission image handling", () => {
  const imageSchema: FormSchema = {
    fields: [
      { key: "photo", label: "Photo", control: "image", required: true },
    ],
  };

  it("fails a required image with no attachment or pending file", () => {
    const errors = validateSubmission(imageSchema, {}, true, new Set(), t);
    expect(errors.photo).toMatch(/requires an image/i);
  });

  it("passes a required image satisfied by a pending/committed file", () => {
    const errors = validateSubmission(
      imageSchema,
      {},
      true,
      new Set(["photo"]),
      t,
    );
    expect(errors.photo).toBeUndefined();
  });

  it("never sends image fields in the payload", () => {
    const payload = formValuesToPayload(imageSchema, { photo: "asset-123" });
    expect(payload).toEqual({});
  });
});
