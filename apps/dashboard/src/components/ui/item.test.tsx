// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Item, ItemGroup } from "./item";

afterEach(cleanup);

describe("ItemGroup", () => {
  it("keeps its list role when it renders a div", () => {
    render(
      <ItemGroup aria-label="Plain">
        <div role="listitem">
          <Item>One</Item>
        </div>
      </ItemGroup>,
    );
    const list = screen.getByRole("list", { name: "Plain" });
    expect(list.tagName).toBe("DIV");
    expect(list).toHaveAttribute("data-slot", "item-group");
  });

  it("renders a native list when asked, without a redundant role", () => {
    render(
      <ItemGroup render={<ul />} aria-label="Native" className="gap-1">
        <li>
          <Item>One</Item>
        </li>
        <li>
          <Item>Two</Item>
        </li>
      </ItemGroup>,
    );
    const list = screen.getByRole("list", { name: "Native" });
    expect(list.tagName).toBe("UL");
    expect(list).not.toHaveAttribute("role");
    expect(list).toHaveClass("gap-1");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
