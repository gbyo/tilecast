// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FormSchema } from "../api/types";
import { FormRenderer } from "./FormRenderer";

afterEach(cleanup);

const schema: FormSchema = {
  title: "Staff Announcement",
  description: "Tell us what to post.",
  fields: [
    { key: "title", label: "Title", control: "short_text", required: true },
    { key: "body", label: "Body", control: "long_text" },
    { key: "intro", label: "Section heading", control: "section" },
    {
      key: "tip",
      label: "Tip",
      control: "help_text",
      description: "Be concise.",
    },
    { key: "photo", label: "Photo", control: "image" },
  ],
};

describe("FormRenderer", () => {
  it("renders title, description, and fields with required markers", () => {
    render(<FormRenderer schema={schema} readOnly />);
    expect(screen.getByText("Staff Announcement")).toBeInTheDocument();
    expect(screen.getByText("Tell us what to post.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Title/)).toBeInTheDocument();
    // Section renders as a heading, not an input.
    expect(
      screen.getByRole("heading", { name: "Section heading" }),
    ).toBeInTheDocument();
    // Help text renders as presentation text.
    expect(screen.getByText("Be concise.")).toBeInTheDocument();
    // Image renders a disabled file picker in preview.
    expect(screen.getByLabelText(/Photo/)).toBeDisabled();
  });

  it("disables inputs in read-only mode", () => {
    render(<FormRenderer schema={schema} readOnly />);
    expect(screen.getByLabelText(/Title/)).toBeDisabled();
  });

  it("announces a field error through the control it belongs to", () => {
    render(
      <FormRenderer
        schema={schema}
        idPrefix="t"
        onChange={() => {}}
        errors={{ title: "Title is required." }}
      />,
    );
    const title = screen.getByLabelText(/Title/);
    expect(title).toHaveAttribute("aria-invalid", "true");
    // The error text must be reachable from the control, not just visually adjacent to it.
    expect(title).toHaveAccessibleDescription(/Title is required\./);
    // Untouched fields stay clean.
    expect(screen.getByLabelText(/Body/)).not.toHaveAttribute("aria-invalid");
  });

  it("gives a multi-select native group semantics instead of a label pointing at a div", () => {
    render(
      <FormRenderer
        schema={{
          fields: [
            {
              key: "tags",
              label: "Tags",
              control: "multi_select",
              options: [
                { value: "a", label: "Alpha" },
                { value: "b", label: "Beta" },
              ],
            },
          ],
        }}
        onChange={() => {}}
      />,
    );
    const group = screen.getByRole("group", { name: "Tags" });
    expect(group.tagName).toBe("FIELDSET");
    expect(screen.getByRole("checkbox", { name: "Alpha" })).toBeInTheDocument();
  });

  it("labels a boolean field on its own checkbox", () => {
    render(
      <FormRenderer
        schema={{
          fields: [{ key: "ok", label: "Approved", control: "boolean" }],
        }}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByRole("checkbox", { name: "Approved" }),
    ).not.toBeChecked();
  });

  it("shows the remaining character budget when a field is capped", () => {
    render(
      <FormRenderer
        schema={{
          fields: [
            {
              key: "note",
              label: "Note",
              control: "short_text",
              maxLength: 10,
            },
          ],
        }}
        values={{ note: "abc" }}
        onChange={() => {}}
      />,
    );
    // The control hard-caps typing, so the limit has to be visible before it is hit.
    expect(screen.getByText("7 of 10 characters left")).toBeInTheDocument();
  });

  it("does not offer a character budget on a read-only render", () => {
    render(
      <FormRenderer
        schema={{
          fields: [
            {
              key: "note",
              label: "Note",
              control: "short_text",
              maxLength: 10,
            },
          ],
        }}
        values={{ note: "abc" }}
        readOnly
      />,
    );
    expect(screen.queryByText(/characters left/)).not.toBeInTheDocument();
  });

  it("renders a short option list as a radio group that writes one value", () => {
    const onChange = vi.fn();
    render(
      <FormRenderer
        schema={{
          fields: [
            {
              key: "choice",
              label: "Choice",
              control: "select",
              options: [
                { value: "a", label: "Alpha" },
                { value: "b", label: "Beta" },
              ],
            },
          ],
        }}
        onChange={onChange}
      />,
    );
    expect(
      screen.getByRole("radiogroup", { name: "Choice" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Alpha" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Beta" }));
    expect(onChange).toHaveBeenCalledWith("choice", "b");
  });

  it("renders a long option list as a dropdown instead of radios", () => {
    render(
      <FormRenderer
        schema={{
          fields: [
            {
              key: "choice",
              label: "Choice",
              control: "select",
              options: [
                { value: "a", label: "Alpha" },
                { value: "b", label: "Beta" },
                { value: "c", label: "Gamma" },
                { value: "d", label: "Delta" },
              ],
            },
          ],
        }}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Choice" }),
    ).toBeInTheDocument();
  });

  it("renders text inputs through the shared input control", () => {
    render(
      <FormRenderer
        schema={{
          fields: [
            { key: "title", label: "Title", control: "short_text" },
            { key: "body", label: "Body", control: "long_text" },
          ],
        }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText(/Title/)).toHaveAttribute(
      "data-slot",
      "input",
    );
    expect(screen.getByLabelText(/Body/).tagName).toBe("TEXTAREA");
  });
});
