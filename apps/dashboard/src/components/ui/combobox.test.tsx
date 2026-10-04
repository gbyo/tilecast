// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxInput,
  ComboboxValue,
} from "./combobox";

afterEach(cleanup);

type Fruit = { id: string; label: string };

const fruits: Fruit[] = [
  { id: "apple", label: "Apple" },
  { id: "pear", label: "Pear" },
];

describe("Combobox accessible names", () => {
  it("names the trigger and clear controls", () => {
    render(
      <Combobox
        items={fruits}
        defaultValue={fruits[0] as Fruit}
        itemToStringLabel={(item: Fruit) => item.label}
      >
        <ComboboxInput aria-label="Pick a fruit" showClear />
      </Combobox>,
    );

    expect(
      screen.getByRole("button", { name: "Toggle options" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("names the chip remove control", () => {
    render(
      <Combobox
        items={fruits}
        multiple
        defaultValue={[fruits[0] as Fruit]}
        itemToStringLabel={(item: Fruit) => item.label}
      >
        <ComboboxChips>
          <ComboboxValue>
            {(value: Fruit[]) =>
              value.map((item) => (
                <ComboboxChip key={item.id}>{item.label}</ComboboxChip>
              ))
            }
          </ComboboxValue>
          <ComboboxChipsInput aria-label="Pick fruits" />
        </ComboboxChips>
      </Combobox>,
    );

    expect(screen.getByText("Apple")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });
});
