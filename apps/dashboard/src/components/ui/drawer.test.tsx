// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_HANDLER_NAME } from "../../native-host/protocol";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerIndentShell,
  DrawerTitle,
} from "./drawer";

afterEach(() => {
  cleanup();
  delete window.webkit;
});

function renderApp(open: boolean) {
  render(
    <DrawerIndentShell>
      <main>Page</main>
      <Drawer open={open}>
        <DrawerContent>
          <DrawerTitle>Details</DrawerTitle>
          <DrawerDescription>Drawer description</DrawerDescription>
        </DrawerContent>
      </Drawer>
    </DrawerIndentShell>,
  );
}

const indent = () =>
  document.body.querySelector<HTMLElement>('[data-slot="drawer-indent"]');

describe("DrawerIndentShell", () => {
  it("is inactive while no drawer is open", () => {
    renderApp(false);

    expect(indent()).toHaveAttribute("data-inactive");
    expect(indent()).not.toHaveAttribute("data-active");
    expect(indent()).toContainElement(screen.getByText("Page"));
  });

  it("marks the page active while a drawer is open and tags the scrim", () => {
    renderApp(true);

    expect(indent()).toHaveAttribute("data-active");
    expect(
      document.body.querySelector('[data-slot="drawer-overlay"]'),
    ).toHaveAttribute("data-indent");
    expect(
      document.body.querySelector('[data-slot="drawer-popup"]'),
    ).toHaveAttribute("data-indent");
  });

  it("leaves the page and drawer untouched inside the native host", () => {
    window.webkit = {
      messageHandlers: { [NATIVE_HANDLER_NAME]: { postMessage() {} } },
    };
    renderApp(true);

    expect(indent()).toBeNull();
    expect(
      document.body.querySelector('[data-slot="drawer-overlay"]'),
    ).not.toHaveAttribute("data-indent");
    expect(
      document.body.querySelector('[data-slot="drawer-popup"]'),
    ).not.toHaveAttribute("data-indent");
  });
});
