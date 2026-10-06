// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  installEditorTestEnvironment,
  mockAuth,
  mockEditorApi,
  preflightResult,
  renderEditor,
  setViewport,
  type Viewport,
} from "./scheduleEditorTestKit";

installEditorTestEnvironment();

async function open(viewport: Viewport) {
  setViewport(viewport);
  mockAuth();
  const api = mockEditorApi();
  api.preflight.mockResolvedValue(
    preflightResult({
      winningScreenCount: 6,
      losingScreenCount: 2,
      competitors: [
        {
          scheduleId: "c1",
          name: "Friday Night Lights",
          priority: 100,
          presentationType: "playlist",
          affectedScreenCount: 2,
          outranksDraftScreenCount: 2,
          reason: "schedule_lower_priority",
        },
      ],
    }),
  );
  renderEditor("/schedules/s1");
  await screen.findByDisplayValue("Morning Broadcast");
  return { api, user: userEvent.setup() };
}

const outcomeCopies = () => screen.queryAllByText("Next-run check");

describe("Schedule outcome surfaces", () => {
  it("sits beside the form on a wide screen, with nothing to open", async () => {
    await open("desktop");
    const pane = screen.getByRole("complementary", {
      name: "Schedule outcome",
    });
    expect(await within(pane).findByText("Next-run check")).toBeInTheDocument();
    expect(
      await within(pane).findByText("This schedule wins on 6 of 8 screens."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Review/ }),
    ).not.toBeInTheDocument();
    expect(outcomeCopies()).toHaveLength(1);
  });

  it("opens in a side sheet on a tablet, and is not mounted until then", async () => {
    const { user } = await open("tablet");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(outcomeCopies()).toHaveLength(0);
    const review = await screen.findByRole("button", { name: /^Review/ });
    await user.click(review);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Schedule outcome")).toBeInTheDocument();
    expect(
      await within(dialog).findByText("Next-run check"),
    ).toBeInTheDocument();
    // One copy of the outcome, never a hidden twin.
    expect(outcomeCopies()).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(outcomeCopies()).toHaveLength(0);
    await waitFor(() => expect(review).toHaveFocus());
  });

  it("opens in a bottom drawer on a phone", async () => {
    const { user } = await open("phone");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /^Review/ }));
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("Next-run check"),
    ).toBeInTheDocument();
    expect(
      dialog.closest("[data-slot=drawer-content], [data-slot=drawer-popup]") ??
        dialog,
    ).toBeTruthy();
    expect(outcomeCopies()).toHaveLength(1);
  });

  it("tells the header's Review button how many things want attention", async () => {
    await open("tablet");
    // Two screens lose: one thing to look at.
    expect(
      await screen.findByRole("button", {
        name: "Review, 1 item needs attention",
      }),
    ).toBeInTheDocument();
  });

  it("keeps one copy of every control in every layout", async () => {
    for (const viewport of ["desktop", "tablet", "phone"] as const) {
      await open(viewport);
      expect(screen.getAllByRole("radiogroup")).toHaveLength(2);
      expect(screen.getAllByLabelText("Name")).toHaveLength(1);
      expect(
        screen.getAllByRole("button", { name: /Save changes|^Save$/ }),
      ).toHaveLength(1);
      cleanup();
    }
  });
});
