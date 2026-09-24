// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import { AuthPage } from "./AuthPage";

function renderSetup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/setup"]}>
        <AuthProvider>
          <AuthPage mode="setup" />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function jsonResponse(data: unknown, ok = true, statusCode = 200) {
  return {
    ok,
    status: statusCode,
    json: () => Promise.resolve(ok ? { data } : data),
  } as Response;
}

async function answerCurrentQuestion(label: string, value: string) {
  const input = await screen.findByLabelText(label);
  await userEvent.type(input, value);
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
}

describe("guided first-install setup", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("walks Organization, Owner account, then Review before creating", async () => {
    const requests: { url: string; body?: unknown }[] = [];
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      const url = input;
      if (url.endsWith("/auth/status"))
        return Promise.resolve(
          jsonResponse({ setupRequired: true, authenticated: false }),
        );
      if (url.endsWith("/auth/setup")) {
        requests.push({
          url,
          body: JSON.parse(init?.body as string) as unknown,
        });
        return Promise.resolve(
          jsonResponse({
            user: {
              id: "user-1",
              name: "Ada Lovelace",
              username: "ada",
              role: "owner",
              active: true,
              createdAt: "2026-01-01T00:00:00Z",
            },
            csrfToken: "csrf",
            authMethod: "password",
            mfaEnrollmentRequired: false,
          }),
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSetup();

    expect(
      await screen.findByRole("heading", { name: "Set up Tilecast" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Question 1 of 5")).toBeInTheDocument();

    await answerCurrentQuestion("Organization name", "Acme Library");
    expect(await screen.findByText("Question 2 of 5")).toBeInTheDocument();
    await answerCurrentQuestion("Your name", "Ada Lovelace");
    await answerCurrentQuestion("Email or username", "ada");
    await answerCurrentQuestion("Password", "a very long password");
    expect(await screen.findByText("Question 5 of 5")).toBeInTheDocument();
    await userEvent.type(
      await screen.findByLabelText("Confirm password"),
      "a very long password",
    );
    await userEvent.click(screen.getByRole("button", { name: "Review" }));

    // The review step summarizes without echoing the password, and the
    // installation is created only from there.
    expect(
      await screen.findByRole("heading", { name: "Review and create" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Acme Library")).toBeInTheDocument();
    expect(requests).toHaveLength(0);

    await userEvent.click(
      screen.getByRole("button", { name: "Create installation" }),
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.url).toContain("/auth/setup");
    expect(requests[0]?.body).toEqual({
      organizationName: "Acme Library",
      ownerName: "Ada Lovelace",
      username: "ada",
      password: "a very long password",
    });
  });

  it("refuses to advance with an invalid answer and keeps the schema message", async () => {
    const fetchMock = vi.fn((input: string) => {
      if (input.endsWith("/auth/status"))
        return Promise.resolve(
          jsonResponse({ setupRequired: true, authenticated: false }),
        );
      throw new Error(`unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSetup();
    await screen.findByLabelText("Organization name");

    // Next is owned by the questionnaire until the question is answered.
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Question 1 of 5")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Organization name"), "A");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    // One character is below the schema minimum, so the flow stays and
    // reports the same message the single-form setup used.
    expect(
      await screen.findByText("Enter an organization name"),
    ).toBeInTheDocument();
    expect(screen.getByText("Question 1 of 5")).toBeInTheDocument();
  });

  it("catches a mismatched confirmation on review submit", async () => {
    const fetchMock = vi.fn((input: string) => {
      if (input.endsWith("/auth/status"))
        return Promise.resolve(
          jsonResponse({ setupRequired: true, authenticated: false }),
        );
      throw new Error(`unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSetup();

    await answerCurrentQuestion("Organization name", "Acme Library");
    await answerCurrentQuestion("Your name", "Ada Lovelace");
    await answerCurrentQuestion("Email or username", "ada");
    await answerCurrentQuestion("Password", "a very long password");
    await userEvent.type(
      await screen.findByLabelText("Confirm password"),
      "a different password!",
    );
    await userEvent.click(screen.getByRole("button", { name: "Review" }));

    expect(
      await screen.findByText("Passwords do not match"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Review and create" }),
    ).toBeNull();
  });
});
