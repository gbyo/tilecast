// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { NativePresentationContext } from "../native-presentation/presentationContext";
import type { ApprovalForm } from "./pairingFlow";
import { makeApprovalSchema, PairingDetailsForm } from "./PairingDetailsForm";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const t = i18n.getFixedT("en", "screens");

function Harness() {
  const { t: translate } = useTranslation("screens");
  const form = useForm<ApprovalForm>({
    resolver: zodResolver(
      useMemo(() => makeApprovalSchema(translate), [translate]),
    ),
    defaultValues: {
      name: "",
      locationId: undefined,
      roomName: "",
      roomNumber: "",
      description: "",
    },
  });
  return <PairingDetailsForm form={form} locations={[]} />;
}

describe("makeApprovalSchema", () => {
  it("requires a screen name of at least two characters", () => {
    const schema = makeApprovalSchema(t);
    expect(
      schema.safeParse({
        name: "Lobby Display",
        roomName: "",
        roomNumber: "",
        description: "",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        name: "x",
        roomName: "",
        roomNumber: "",
        description: "",
      }).success,
    ).toBe(false);
  });

  it("keeps location and room details optional", () => {
    const parsed = makeApprovalSchema(t).safeParse({
      name: "Lobby Display",
      roomName: "",
      roomNumber: "",
      description: "",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("PairingDetailsForm", () => {
  it("shows name and location first with details collapsed", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("Screen name")).toBeInTheDocument();
    expect(screen.getByText("Location (optional)")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Room name (optional)"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More details" }));

    expect(screen.getByLabelText("Room name (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Room number (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Description (optional)")).toBeInTheDocument();
  });

  it("leaves a native presentation to create a location", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(
      <MemoryRouter>
        <NativePresentationContext.Provider value={{ navigate } as never}>
          <Harness />
        </NativePresentationContext.Provider>
      </MemoryRouter>,
    );

    await user.click(
      screen.getByRole("button", { name: "Create new location" }),
    );

    expect(navigate).toHaveBeenCalledWith("/settings/locations");
  });
});
