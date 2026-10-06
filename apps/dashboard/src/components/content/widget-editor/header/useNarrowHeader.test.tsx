// @vitest-environment jsdom
// The editor's header controls collapse by the header's own width, because
// the sidebar shares its row: a 768px window with the sidebar open leaves
// the header about 500px wide.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EditorHeaderProvider,
  useEditorHeaderSlots,
} from "@/components/studio/EditorHeaderSlots";
import { HEADER_FULL_WIDTH, useNarrowHeader } from "./useNarrowHeader";

let observers: (() => void)[] = [];

beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Shell({ width }: { width: { current: number } }) {
  const slots = useEditorHeaderSlots();
  return (
    <header
      ref={(element) => {
        if (element)
          Object.defineProperty(element, "clientWidth", {
            configurable: true,
            get: () => width.current,
          });
      }}
    >
      <div ref={slots?.setRight} />
      <Probe />
    </header>
  );
}

function Probe() {
  return <output>{useNarrowHeader() ? "narrow" : "full"}</output>;
}

function renderShell(initial: number) {
  const width = { current: initial };
  render(
    <EditorHeaderProvider>
      <Shell width={width} />
    </EditorHeaderProvider>,
  );
  return width;
}

describe("useNarrowHeader", () => {
  it("is full when the header has room for every control", () => {
    renderShell(HEADER_FULL_WIDTH);
    expect(screen.getByRole("status").textContent).toBe("full");
  });

  it("is narrow below the full width, as with a tablet and its sidebar open", () => {
    renderShell(504);
    expect(screen.getByRole("status").textContent).toBe("narrow");
  });

  it("follows the header as it is resized", () => {
    const width = renderShell(1000);
    expect(screen.getByRole("status").textContent).toBe("full");
    width.current = 600;
    act(() => observers.forEach((callback) => callback()));
    expect(screen.getByRole("status").textContent).toBe("narrow");
    width.current = 900;
    act(() => observers.forEach((callback) => callback()));
    expect(screen.getByRole("status").textContent).toBe("full");
  });

  it("treats an unmeasured header as wide", () => {
    renderShell(0);
    expect(screen.getByRole("status").textContent).toBe("full");
  });
});
