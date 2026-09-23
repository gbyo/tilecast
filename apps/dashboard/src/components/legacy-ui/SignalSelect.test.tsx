// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Field } from ".";
import { Select } from "./SignalSelect";

// Several cases below render the same field label, so rendered trees must not accumulate.
afterEach(cleanup);

describe("Signal Select", () => {
  it("opens a Signal listbox and emits native select changes", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    function Example() {
      const [value, setValue] = useState("one");
      return (
        <Select
          aria-label="Example"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            changed(event.target.value);
          }}
        >
          <option value="one">One</option>
          <option value="two">Two</option>
        </Select>
      );
    }
    render(<Example />);
    await user.click(screen.getByRole("combobox", { name: "Example" }));
    await user.click(screen.getByRole("option", { name: "Two" }));
    expect(changed).toHaveBeenCalledWith("two");
    expect(
      screen.getByRole("combobox", { name: "Example" }).textContent,
    ).toContain("Two");
  });

  it("supports grouped options and keyboard selection", async () => {
    const changed = vi.fn();
    render(
      <Select aria-label="Target" defaultValue="playlist" onChange={changed}>
        <optgroup label="Content">
          <option value="playlist">Playlist</option>
          <option value="layout">Layout</option>
        </optgroup>
      </Select>,
    );
    const trigger = screen.getByRole("combobox", { name: "Target" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const first = await screen.findByRole("option", { name: "Playlist" });
    fireEvent.keyDown(first, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("option", { name: "Layout" }), {
      key: "Enter",
    });
    expect(changed).toHaveBeenCalled();
    expect(trigger.textContent).toContain("Layout");
  });
});

// Studio's fields wrap their control in a <label>, and a label names its first labelable
// descendant. Select renders both a visually hidden native <select> and the visible trigger
// button, so while the native select came first the label's text went to an aria-hidden element
// and nearly every select in the app was unnamed to a screen reader.
describe("Signal Select accessible name", () => {
  it("takes its name from a wrapping label", () => {
    render(
      <label className="field">
        <span className="field__label">Data Source</span>
        <Select value="a" onChange={vi.fn()}>
          <option value="a">Alpha</option>
        </Select>
      </label>,
    );

    expect(screen.getByRole("combobox", { name: "Data Source" })).toBeTruthy();
  });

  it("takes its name from the Field primitive", () => {
    render(
      <Field label="Timezone">
        <Select value="a" onChange={vi.fn()}>
          <option value="a">UTC</option>
        </Select>
      </Field>,
    );

    expect(screen.getByRole("combobox", { name: /Timezone/ })).toBeTruthy();
  });

  it("still honors an explicit aria-label", () => {
    render(
      <Select aria-label="Filter by provider" value="a" onChange={vi.fn()}>
        <option value="a">Alpha</option>
      </Select>,
    );

    expect(
      screen.getByRole("combobox", { name: "Filter by provider" }),
    ).toBeTruthy();
  });

  // The native select carries form semantics and change events. It must stay out of the
  // accessibility tree and out of the tab order so it never becomes a second keyboard stop.
  it("keeps the native select hidden and unfocusable", () => {
    const { container } = render(
      <label className="field">
        <span className="field__label">Data Source</span>
        <Select value="a" onChange={vi.fn()}>
          <option value="a">Alpha</option>
        </Select>
      </label>,
    );

    const native = container.querySelector("select");
    expect(native?.getAttribute("aria-hidden")).toBe("true");
    expect(native?.getAttribute("tabindex")).toBe("-1");
  });

  // Clicking the label now activates the trigger rather than a hidden element, which is what
  // makes the label a usable target for opening the menu.
  it("opens the menu when the label is clicked", async () => {
    const user = userEvent.setup();
    render(
      <label className="field">
        <span className="field__label">Data Source</span>
        <Select value="a" onChange={vi.fn()}>
          <option value="a">Alpha</option>
          <option value="b">Beta</option>
        </Select>
      </label>,
    );

    const trigger = screen.getByRole("combobox", { name: "Data Source" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(screen.getByText("Data Source"));

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  // A modal <dialog> is painted in the browser's top layer, above every z-index
  // in the document, and makes the rest of the page inert. A menu portaled to
  // <body> from inside one is therefore invisible and unclickable, which is
  // what the role dropdown in the Edit user dialog was doing.
  it("portals its menu into the modal dialog that owns it", async () => {
    const user = userEvent.setup();
    render(
      <Dialog title="Edit user">
        <Select aria-label="Role" value="editor" onChange={vi.fn()}>
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </Select>
      </Dialog>,
    );

    await user.click(screen.getByRole("combobox", { name: "Role" }));

    const menu = screen.getByRole("listbox");
    expect(menu.closest("dialog")).not.toBeNull();
    expect(menu.parentElement?.tagName).toBe("DIALOG");
  });
});

/** A minimal stand-in for the shared Dialog: what matters is showModal(). */
function Dialog({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // jsdom has no top layer and no showModal; the open attribute is what the
    // portal target reads there.
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);
  return (
    <dialog ref={ref} aria-label={title}>
      {children}
    </dialog>
  );
}
