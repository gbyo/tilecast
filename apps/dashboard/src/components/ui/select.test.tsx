// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

afterEach(cleanup);

describe("Select field labels", () => {
  it("exposes the FieldLabel as the combobox accessible name", () => {
    render(
      <Field>
        <FieldLabel htmlFor="timezone">Timezone</FieldLabel>
        <Select items={[{ label: "UTC", value: "UTC" }]}>
          <SelectTrigger id="timezone">
            <SelectValue placeholder="Choose a timezone" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="UTC">UTC</SelectItem>
          </SelectContent>
        </Select>
      </Field>,
    );

    expect(screen.getByRole("combobox", { name: "Timezone" })).toBeVisible();
  });
});
