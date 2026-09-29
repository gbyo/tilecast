import { describe, expect, it } from "vitest";
import { queryFromSearchParams } from "./media";

describe("queryFromSearchParams", () => {
  it("keeps free-text values exactly as typed", () => {
    expect(queryFromSearchParams(new URLSearchParams("search=0042"))).toEqual({
      search: "0042",
    });
    expect(queryFromSearchParams(new URLSearchParams("search=1.50"))).toEqual({
      search: "1.50",
    });
  });

  it("converts only the declared integer parameters", () => {
    expect(
      queryFromSearchParams(
        new URLSearchParams("page=2&pageSize=24&search=7&type=image"),
      ),
    ).toEqual({ page: 2, pageSize: 24, search: "7", type: "image" });
  });

  it("leaves a non-numeric page for the Server to reject", () => {
    expect(queryFromSearchParams(new URLSearchParams("page=abc"))).toEqual({
      page: "abc",
    });
  });
});
