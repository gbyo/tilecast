// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "../components/ui/toast";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import { EnrollmentWizard, LoadingButton } from "./EnrollmentWizard";

const authStatus = {
  setupRequired: false,
  authenticated: true,
  user: {
    id: "user-1",
    name: "Gibson Bell",
    username: "gibson@example.org",
    role: "owner",
    active: true,
    createdAt: "2026-01-01T00:00:00Z",
  },
  csrfToken: "csrf",
  authMethod: "password",
  mfaEnrollmentRequired: true,
  passkeysAvailable: true,
  passkeysUnavailableReason: "",
};

const security = {
  relyingPartyId: "studio.example.org",
  userHandle: "",
  totpEnrolled: false,
  passkeys: [] as unknown[],
  recoveryCodesRemaining: 0,
  enrolled: false,
  passkeysAvailable: true,
  passkeysUnavailableReason: "",
  required: true,
  policy: "all",
  authMethod: "password",
};

/**
 * Realistic fetch stub body: the typed transport reads through
 * openapi-fetch (headers and all), so doubles must be real Responses,
 * not json-only fakes.
 */
function jsonResponse(data: unknown, ok = true, statusCode = 200) {
  return new Response(JSON.stringify(ok ? { data } : data), {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

/** The transport calls fetch(urlString, init); tolerate a Request too. */
function requestUrl(input: string | Request): string {
  return typeof input === "string" ? input : input.url;
}

/**
 * The security state the server reports changes as the wizard works through
 * its steps, so the fake keeps it in a mutable record rather than replaying one
 * fixed payload.
 */
function stubServer(overrides: Partial<typeof security> = {}) {
  const state = { ...security, ...overrides };
  const calls: string[] = [];
  const fetchMock = vi.fn((input: string | Request) => {
    calls.push(requestUrl(input));
    if (requestUrl(input).endsWith("/auth/status"))
      return Promise.resolve(jsonResponse(authStatus));
    if (requestUrl(input).endsWith("/me/security"))
      return Promise.resolve(jsonResponse(state));
    if (requestUrl(input).endsWith("/me/security/totp"))
      return Promise.resolve(
        jsonResponse({
          provisioningUri: "otpauth://totp/Tilecast:gibson?secret=ABCDEF",
          secret: "ABCDEF",
        }),
      );
    if (requestUrl(input).endsWith("/me/security/totp/confirm")) {
      state.totpEnrolled = true;
      return Promise.resolve(jsonResponse(state));
    }
    if (requestUrl(input).endsWith("/me/security/recovery-codes")) {
      state.recoveryCodesRemaining = 2;
      return Promise.resolve(
        jsonResponse({ codes: ["aaaa-bbbb", "cccc-dddd"] }),
      );
    }
    throw new Error(`unexpected request: ${requestUrl(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, state };
}

function renderWizard(onFinish = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <EnrollmentWizard onFinish={onFinish} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return onFinish;
}

describe("the guided first sign-in", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // jsdom has no WebAuthn, so the passkey step would otherwise be planned
    // out of every case.
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    vi.stubGlobal("navigator", navigator);
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { create: vi.fn(), get: vi.fn() },
    });
  });
  afterEach(cleanup);

  it("greets the user by first name and names the steps ahead", async () => {
    stubServer();
    renderWizard();

    expect(
      await screen.findByRole("heading", { name: "Hello, Gibson." }),
    ).toBeTruthy();
    expect(screen.getByText("Authenticator app")).toBeTruthy();
    expect(screen.getByText("Recovery codes")).toBeTruthy();
    expect(screen.getByText("Passkey")).toBeTruthy();
  });

  it("walks the authenticator, recovery code, and passkey steps in order", async () => {
    stubServer();
    const onFinish = renderWizard();

    await userEvent.click(
      await screen.findByRole("button", { name: "Get started" }),
    );
    expect(await screen.findByText("Step 1 of 3")).toBeTruthy();

    await userEvent.type(
      await screen.findByLabelText("Six-digit code"),
      "123456",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm and continue" }),
    );

    // The gate must not lift here: recovery codes and a passkey are still owed.
    expect(
      await screen.findByRole("heading", { name: "Save your recovery codes" }),
    ).toBeTruthy();
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();

    await userEvent.type(
      screen.getByLabelText(/Confirm your password/),
      "a long password",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Generate codes" }),
    );
    expect(await screen.findByText("aaaa-bbbb")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "I have saved them" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Add a passkey" }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(
      await screen.findByRole("heading", { name: "You're set, Gibson." }),
    ).toBeTruthy();
    expect(screen.getByText("Authenticator app added")).toBeTruthy();
    expect(screen.getByText("2 recovery codes issued")).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Enter Tilecast Studio" }),
    );
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
  });

  it("plans no passkey step when the installation cannot run a ceremony", async () => {
    stubServer({
      passkeysAvailable: false,
      passkeysUnavailableReason: "Passkeys require HTTPS.",
    });
    renderWizard();

    await userEvent.click(
      await screen.findByRole("button", { name: "Get started" }),
    );
    expect(await screen.findByText("Step 1 of 2")).toBeTruthy();
    expect(screen.queryByText("Passkey")).toBeNull();
  });

  it("says so when the browser cannot copy the recovery codes", async () => {
    stubServer();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const feedback = vi.spyOn(toast, "add");
    try {
      renderWizard();
      await userEvent.click(
        await screen.findByRole("button", { name: "Get started" }),
      );
      await userEvent.type(
        await screen.findByLabelText("Six-digit code"),
        "123456",
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Confirm and continue" }),
      );
      await userEvent.type(
        await screen.findByLabelText(/Confirm your password/),
        "a long password",
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Generate codes" }),
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "Copy all" }),
      );
      expect(feedback).toHaveBeenCalledWith({
        title:
          "This browser cannot copy to the clipboard. Write the codes down instead.",
        type: "error",
      });
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  }, 15_000);

  it("starts at the step the account still owes", async () => {
    stubServer({ totpEnrolled: true });
    renderWizard();

    await userEvent.click(
      await screen.findByRole("button", { name: "Get started" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Save your recovery codes" }),
    ).toBeTruthy();
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
  });
});

describe("LoadingButton", () => {
  afterEach(() => {
    cleanup();
  });

  it("stays enabled when settled and no disabled state is requested", () => {
    render(<LoadingButton loading={false}>Save</LoadingButton>);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("disables while loading even when disabled is explicitly false", () => {
    render(
      <LoadingButton loading={true} disabled={false}>
        Save
      </LoadingButton>,
    );
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("honors an explicit disabled state when not loading", () => {
    render(
      <LoadingButton loading={false} disabled={true}>
        Save
      </LoadingButton>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("aria-busy", "true");
  });
});
