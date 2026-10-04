import { describe, expect, it } from "vitest";
import { formatDateTime } from "./dateTime";

describe("Studio timestamp display", () => {
  it.each([
    ["en-US", /Jan/],
    ["es-ES", /ene/],
    ["ru-RU", /янв/],
  ])("uses the supplied %s locale", (locale, month) => {
    const displayed = formatDateTime("2026-01-18T12:34:00Z", locale);
    expect(displayed).toMatch(month);
    expect(displayed).toContain("2026");
    expect(displayed).toMatch(/\d{1,2}:34/);
  });

  it.each([undefined, null, "", "invalid", "2026-99-99T00:00:00Z"])(
    "uses a caller's missing label for %s",
    (value) => {
      expect(formatDateTime(value, "en-US")).toBe("—");
      expect(formatDateTime(value, "es-ES", "Desconocido")).toBe("Desconocido");
    },
  );
});
