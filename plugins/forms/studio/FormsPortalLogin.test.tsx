// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StudioSessionProvider,
  testStudioSession,
} from "@tilecast/studio/testing";
import { FormsPortalShell } from "./FormsPortalPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Forms portal sign-in", () => {
  it("returns a signed-out visitor to the exact page they asked for", () => {
    const session = {
      ...testStudioSession("viewer"),
      csrfToken: "",
      authenticated: false,
    };
    const router = createMemoryRouter(
      [
        {
          path: "/plugins/forms/*",
          element: (
            <StudioSessionProvider session={session}>
              <FormsPortalShell />
            </StudioSessionProvider>
          ),
        },
        { path: "/login", element: <Outlet /> },
      ],
      { initialEntries: ["/plugins/forms/forms/f1?tab=responses#record-7"] },
    );
    render(<RouterProvider router={router} />);
    const returnTo = new URLSearchParams(router.state.location.search).get(
      "returnTo",
    );
    // The query string and fragment must survive the trip through login.
    expect(router.state.location.pathname).toBe("/login");
    expect(returnTo).toBe("/plugins/forms/forms/f1?tab=responses#record-7");
  });
});
