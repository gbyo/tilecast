// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { SessionResult } from "../api/types";
import { AuthProvider, useAuth } from "./AuthProvider";

const session: SessionResult = {
  csrfToken: "csrf-for-session",
  user: {
    id: "account-1",
    name: "Owner",
    username: "owner",
    role: "owner",
    active: true,
    createdAt: "2026-01-01T00:00:00Z",
  },
};

function Probe() {
  const auth = useAuth();
  return (
    <>
      <p>{auth.status?.authenticated ? "Signed in" : "Signed out"}</p>
      <button onClick={() => void auth.logout()}>Sign out</button>
      <button
        onClick={() =>
          void auth.login({ username: "owner", password: "password" })
        }
      >
        Sign in
      </button>
    </>
  );
}

function mount(authenticated = true) {
  vi.spyOn(api, "authStatus").mockResolvedValue({
    setupRequired: false,
    authenticated,
    ...(authenticated ? session : {}),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["media", "library"], ["previous account's media"]);
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.spyOn(api, "logout").mockResolvedValue(undefined);
  vi.spyOn(api, "login").mockResolvedValue(session);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("removes account data and cancels in-flight reads after sign-out", async () => {
  const client = mount();
  await screen.findByText("Signed in");
  let aborted = false;
  const pending = client
    .fetchQuery({
      queryKey: ["screens", "list"],
      queryFn: ({ signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => {});
      },
    })
    .catch(() => undefined);

  await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByText("Signed out");
  expect(client.getQueryData(["media", "library"])).toBeUndefined();
  expect(client.getQueryData(["screens", "list"])).toBeUndefined();
  expect(aborted).toBe(true);
  await pending;
  expect(client.getQueryData(["auth", "status"])).toMatchObject({
    authenticated: false,
  });
});

it("clears expired-session data when a new sign-in completes", async () => {
  const client = mount(false);
  await waitFor(() => expect(api.authStatus).toHaveBeenCalled());
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByText("Signed in");
  expect(client.getQueryData(["media", "library"])).toBeUndefined();
});

it("preserves the current session and its data when sign-out fails", async () => {
  vi.mocked(api.logout).mockRejectedValue(new Error("offline"));
  const client = mount();
  await screen.findByText("Signed in");
  await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(client.getQueryData(["media", "library"])).toEqual([
    "previous account's media",
  ]);
  expect(client.getQueryData(["auth", "status"])).toMatchObject({
    authenticated: true,
  });
});
