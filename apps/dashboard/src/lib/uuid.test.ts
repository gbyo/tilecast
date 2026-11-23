import { afterEach, describe, expect, it, vi } from "vitest";
import { newUuid } from "./uuid";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("newUuid", () => {
  it("uses native randomUUID when available", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    vi.stubGlobal("crypto", {
      randomUUID,
      getRandomValues: vi.fn(),
    });

    expect(newUuid()).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it(
    "builds an RFC 4122 v4 UUID from getRandomValues without randomUUID",
    () => {
      const getRandomValues = vi.fn((bytes: Uint8Array) => {
        bytes.set([
          0x00,
          0x11,
          0x22,
          0x33,
          0x44,
          0x55,
          0x66,
          0x77,
          0x88,
          0x99,
          0xaa,
          0xbb,
          0xcc,
          0xdd,
          0xee,
          0xff,
        ]);
        return bytes;
      });
      vi.stubGlobal("crypto", { getRandomValues });

      expect(newUuid()).toBe("00112233-4455-4677-8899-aabbccddeeff");
      expect(getRandomValues).toHaveBeenCalledOnce();
    },
  );
});
