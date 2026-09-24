import { describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import {
  RESERVED_FIELD_KEYS,
  slugifyKey,
  uniqueKey,
  validateKey,
} from "./formKeys";

const t = i18n.getFixedT("en", "forms");

describe("formKeys", () => {
  it("slugifies labels into valid keys", () => {
    expect(slugifyKey("Meeting title")).toBe("meeting_title");
    expect(slugifyKey("  Room #3 (Main) ")).toBe("room_3_main");
    expect(slugifyKey("123 start")).toBe("f_123_start");
    expect(slugifyKey("")).toBe("field");
  });

  it("generates unique keys avoiding existing and reserved keys", () => {
    expect(uniqueKey("Title", ["title"])).toBe("title_2");
    expect(uniqueKey("state", [])).toBe("state_2"); // reserved -> suffixed
    expect(uniqueKey("Notes", ["notes", "notes_2"])).toBe("notes_3");
  });

  it("terminates and stays unique for a near-64-char base that collides", () => {
    const longLabel = "a".repeat(80); // slugifies to a 64-char base
    const base = slugifyKey(longLabel);
    expect(base.length).toBe(64);
    const key = uniqueKey(longLabel, [base]);
    expect(key).not.toBe(base);
    expect(key.length).toBeLessThanOrEqual(64);
    // A second collision still yields a distinct key.
    expect(uniqueKey(longLabel, [base, key])).not.toBe(key);
  });

  it("rejects reserved keys", () => {
    for (const reserved of RESERVED_FIELD_KEYS) {
      expect(validateKey(reserved, [], undefined, t)).toMatch(/reserved/);
    }
  });

  it("rejects invalid and duplicate keys", () => {
    expect(validateKey("1bad", [], undefined, t)).toMatch(
      /start with a letter/,
    );
    expect(validateKey("bad key", [], undefined, t)).toMatch(
      /start with a letter/,
    );
    expect(validateKey("dup", ["dup"], "other", t)).toMatch(/already uses/);
    expect(validateKey("ok_key", ["ok_key"], "ok_key", t)).toBeNull(); // same field is fine
    expect(validateKey("fresh", ["other"], undefined, t)).toBeNull();
  });
});
