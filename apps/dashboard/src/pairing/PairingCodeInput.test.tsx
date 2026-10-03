// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filterPairingCodeInput,
  PairingCodeInput,
} from "./PairingCodeInput";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("filterPairingCodeInput", () => {
  it("uppercases and keeps the six valid characters", () => {
    expect(filterPairingCodeInput("k7q2xd")).toBe("K7Q2XD");
  });

  it("removes spaces and hyphens like the server normalization", () => {
    expect(filterPairingCodeInput("k7q-2x d")).toBe("K7Q2XD");
  });

  it("refuses the ambiguous characters the server excludes", () => {
    expect(filterPairingCodeInput("01ILOBC234")).toBe("BC234");
  });

  it("caps entry at six characters", () => {
    expect(filterPairingCodeInput("K7Q2XD9A")).toBe("K7Q2XD");
  });
});

describe("PairingCodeInput", () => {
  it("presents six slots as one labelled pairing-code field", () => {
    render(<PairingCodeInput value="" onChange={() => {}} />);
    const field = screen.getByRole("textbox", { name: "Pairing code" });
    expect(field).toBeInTheDocument();
    expect(field).toHaveAttribute("maxlength", "6");
  });

  it("uppercases typed input and refuses invalid characters", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = React.useState("");
      return (
        <PairingCodeInput
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);

    await user.type(
      screen.getByRole("textbox", { name: "Pairing code" }),
      "k0o",
    );

    expect(onChange).toHaveBeenLastCalledWith("K");
    expect(screen.getByRole("textbox", { name: "Pairing code" })).toHaveValue(
      "K",
    );
  });

  it("accepts a pasted code with separators", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PairingCodeInput value="" onChange={onChange} />);
    const field = screen.getByRole("textbox", { name: "Pairing code" });

    await user.click(field);
    await user.paste("k7q-2xd");

    expect(onChange).toHaveBeenLastCalledWith("K7Q2XD");
  });

  it("associates lookup errors with the code field", () => {
    render(
      <PairingCodeInput
        value="K7Q"
        onChange={() => {}}
        error="No waiting player matches this code."
      />,
    );
    const field = screen.getByRole("textbox", { name: "Pairing code" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(
      "No waiting player matches this code.",
    );
  });
});
