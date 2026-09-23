// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { screenTabs } from "../../navigation/WorkspaceTabs";
import { WorkspaceNav } from "./WorkspaceNav";

afterEach(cleanup);

function renderWorkspaceNav(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <WorkspaceNav label="Screens" tabs={screenTabs} />
    </MemoryRouter>,
  );
}

describe("WorkspaceNav", () => {
  it("marks Archive current without marking the Fleet parent current", () => {
    renderWorkspaceNav("/screens/archive");

    expect(screen.getByRole("link", { name: "Archive" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Fleet" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks Fleet current on the screens index", () => {
    renderWorkspaceNav("/screens");

    expect(screen.getByRole("link", { name: "Fleet" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Archive" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
