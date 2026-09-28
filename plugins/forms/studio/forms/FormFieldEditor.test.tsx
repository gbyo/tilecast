// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FormField } from "../types";
import { FormFieldEditor } from "./FormFieldEditor";

afterEach(cleanup);

function Harness({ initial }: { initial: FormField }) {
  const [field, setField] = useState(initial);
  return (
    <FormFieldEditor
      field={field}
      allKeys={[field.key]}
      lock={{ keyLocked: false, controlLocked: false, deleteLocked: false }}
      readOnly={false}
      onChange={setField}
    />
  );
}

describe("FormFieldEditor options", () => {
  it("generates a unique value when adding an option after a removal", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          key: "choice",
          label: "Choice",
          control: "select",
          options: [
            { value: "option_1", label: "Option 1" },
            { value: "option_2", label: "Option 2" },
          ],
        }}
      />,
    );

    // Remove the first option, leaving [option_2].
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    // Add a new option: options.length+1 == 2 collides with option_2, so it must skip to option_3.
    await user.click(screen.getByRole("button", { name: "Add option" }));

    const values = screen
      .getAllByLabelText(/^Option \d+ value$/)
      .map((input) => (input as HTMLInputElement).value);
    expect(values).toHaveLength(2);
    expect(new Set(values).size).toBe(2); // no duplicate values
    expect(values).not.toContain("option_1");
  });
});
