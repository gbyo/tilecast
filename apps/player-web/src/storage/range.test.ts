import { describe, expect, it } from "vitest";
import { mediaResponse, parseRange } from "./range";

describe("verified local media ranges", () => {
  it.each([
    ["bytes=0-0", { start: 0, end: 0 }],
    ["bytes=50-", { start: 50, end: 99 }],
    ["bytes=99-999", { start: 99, end: 99 }],
    ["bytes=-20", { start: 80, end: 99 }],
    ["bytes=-999", { start: 0, end: 99 }],
  ])("handles %s", (header, expected) => {
    expect(parseRange(header, 100)).toEqual(expected);
  });

  it.each([
    "bytes=100-",
    "bytes=2-1",
    "bytes=-0",
    "bytes=-",
    "bytes=0-1,4-5",
    "items=0-1",
    "bytes=1.5-2",
    "bytes=+1-2",
    "bytes=9007199254740992-",
  ])("rejects %s", (header) => expect(parseRange(header, 100)).toBeNull());

  it("handles large files without 32-bit truncation", () => {
    expect(parseRange("bytes=4294967296-", 5_000_000_000)).toEqual({
      start: 4_294_967_296,
      end: 4_999_999_999,
    });
    expect(parseRange("bytes=0-0", 0)).toBeNull();
  });

  it("serves inclusive end offsets and seek bytes", async () => {
    const response = mediaResponse(
      new Request("https://test/player/media/grant", {
        headers: { Range: "bytes=2-4" },
      }),
      new Blob(["0123456789"]),
      "video/mp4",
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-4/10");
    expect(response.headers.get("Content-Length")).toBe("3");
    expect(await response.text()).toBe("234");
  });

  it("returns 416 with the complete object size", () => {
    const response = mediaResponse(
      new Request("https://test/player/media/grant", {
        headers: { Range: "bytes=10-" },
      }),
      new Blob(["0123456789"]),
      "video/mp4",
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */10");
  });

  it("serves the complete verified object for initial playback and HEAD", async () => {
    const file = new Blob(["0123456789"]);
    const response = mediaResponse(
      new Request("https://test/player/media/grant"),
      file,
      "video/mp4",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0123456789");
    const head = mediaResponse(
      new Request("https://test/player/media/grant", {
        method: "HEAD",
        headers: { Range: "bytes=2-4" },
      }),
      file,
      "video/mp4",
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("10");
    expect(await head.text()).toBe("");
  });
});
