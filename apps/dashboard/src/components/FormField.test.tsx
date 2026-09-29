// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FormField } from "./FormField";

afterEach(cleanup);

describe("FormField", () => {
  it("keeps caller descriptions alongside the generated hint", () => {
    render(
      <>
        <p id="context">Shown on the public display.</p>
        <FormField
          id="headline"
          label="Headline"
          hint="Keep it under 60 characters."
          aria-describedby="context"
        />
      </>,
    );

    expect(screen.getByRole("textbox", { name: "Headline" })).toHaveAttribute(
      "aria-describedby",
      "context headline-message",
    );
  });

  it("keeps caller descriptions alongside an error message", () => {
    render(
      <>
        <p id="context">Required for emergency notices.</p>
        <FormField
          id="message"
          label="Message"
          error="Message is required."
          aria-describedby="context"
        />
      </>,
    );

    const input = screen.getByRole("textbox", { name: "Message" });
    expect(input).toHaveAttribute(
      "aria-describedby",
      "context message-message",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
  });
});
