import { describe, expect, it } from "vitest";
import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [1023, "1,023 B"],
    [1024, "1 KiB"],
    [1536, "1.5 KiB"],
    [10.25 * 1024, "10.3 KiB"],
    [1024 ** 2, "1 MiB"],
    [1.5 * 1024 ** 3, "1.5 GiB"],
    [1024 ** 4, "1 TiB"],
    [1024 ** 5, "1 PiB"],
    [1024 ** 6, "1 EiB"],
  ])("formats %s bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes, "en-US")).toBe(expected);
  });

  it("uses the selected locale for fractions and grouping", () => {
    expect(formatBytes(1536, "es-ES")).toBe("1,5 KiB");
    expect(formatBytes(1536, "ru-RU")).toBe("1,5 KiB");
    expect(formatBytes(1023, "ru-RU")).toBe("1\u00a0023 B");
  });

  it.each([undefined, null, -1, NaN, Infinity, -Infinity])(
    "does not report an unknown or invalid count as zero (%s)",
    (bytes) => expect(formatBytes(bytes, "en-US")).toBe("—"),
  );
});
