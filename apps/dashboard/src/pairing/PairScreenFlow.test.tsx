// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import type { PairingRequest, Screen } from "../api/types";
import { NativeHostProvider } from "../native-host/NativeHostProvider";
import { PairScreenFlow } from "./PairScreenFlow";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf", user: { role: "owner" } },
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pairingRequest(overrides: Partial<PairingRequest> = {}): PairingRequest {
  return {
    id: "pairing-1",
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 60_000).toISOString(),
    previouslyPaired: false,
    hasActiveCredential: false,
    credentialReplacementAuthorized: false,
    metadata: {
      playerInstallationId: "installation",
      platform: "android-tv",
      manufacturer: "Google",
      model: "ADT-3",
      androidVersion: "11",
      playerVersion: "0.10.1",
      screenWidth: 1920,
      screenHeight: 1080,
      density: 1.5,
      locale: "en-US",
      timezone: "America/New_York",
    },
    ...overrides,
  };
}

function testScreen(overrides: Partial<Screen> = {}): Screen {
  return {
    id: "screen-9",
    name: "Lobby Display",
    description: "",
    location: "",
    platform: "android-tv",
    deviceManufacturer: "Google",
    deviceModel: "ADT-3",
    androidVersion: "11",
    playerVersion: "0.10.1",
    screenWidth: 1920,
    screenHeight: 1080,
    density: 1.5,
    locale: "en-US",
    timezone: "America/New_York",
    enabled: true,
    pairedAt: new Date().toISOString(),
    lastContactAt: new Date().toISOString(),
    status: "online",
    hasActiveCredential: true,
    ...overrides,
  };
}

const recognizedRequest = () =>
  pairingRequest({
    previouslyPaired: true,
    existingScreenId: "screen-9",
    existingScreenName: "Lobby Display",
    hasActiveCredential: true,
  });

function renderFlow(props: {
  initialCode?: string;
  requestId?: string;
  canManage?: boolean;
  onClose?: () => void;
  onOpenScreen?: (screenId: string) => void;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NativeHostProvider>
        <MemoryRouter>
          <PairScreenFlow
            canManage
            onClose={() => {}}
            onOpenScreen={() => {}}
            {...props}
          />
        </MemoryRouter>
      </NativeHostProvider>
    </QueryClientProvider>,
  );
}

async function resolveCode(code = "k7q2xd") {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Pairing code" }), code);
  await user.click(screen.getByRole("button", { name: "Find player" }));
  return user;
}

describe("PairScreenFlow access gate", () => {
  it("explains the restriction to viewers and editors", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderFlow({ canManage: false, onClose });

    expect(
      screen.getByText("Screen approval requires administrator access."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Return to screens" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("PairScreenFlow code lookup", () => {
  it("requires a code before resolving", async () => {
    const user = userEvent.setup();
    const resolve = vi.spyOn(api, "resolvePairing");
    renderFlow();

    await user.click(screen.getByRole("button", { name: "Find player" }));

    expect(screen.getByText("Enter the six-character code")).toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses malformed codes without a lookup", async () => {
    const resolve = vi.spyOn(api, "resolvePairing");
    renderFlow();
    const user = userEvent.setup();

    await user.type(
      screen.getByRole("textbox", { name: "Pairing code" }),
      "abc12",
    );
    await user.click(screen.getByRole("button", { name: "Find player" }));

    expect(
      screen.getByText("Enter the six characters shown on the player."),
    ).toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("advances to review after resolving", async () => {
    vi.spyOn(api, "resolvePairing").mockResolvedValue(pairingRequest());
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    renderFlow();

    await resolveCode();

    expect(
      await screen.findByRole("heading", { name: "Review this player" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Google ADT-3")).toBeInTheDocument();
    expect(screen.getByText("Create new screen")).toBeInTheDocument();
    expect(screen.getByLabelText("Screen name")).toBeInTheDocument();
  });

  it("keeps the code available when no player matches", async () => {
    vi.spyOn(api, "resolvePairing").mockRejectedValue(
      new ApiError("missing", 404, "not_found"),
    );
    renderFlow();

    await resolveCode();

    expect(
      await screen.findByText("No waiting player matches this code."),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Pairing code" })).toHaveValue(
      "K7Q2XD",
    );
  });

  it("reports an expired code distinctly", async () => {
    vi.spyOn(api, "resolvePairing").mockRejectedValue(
      new ApiError("expired", 410, "pairing_expired"),
    );
    renderFlow();

    await resolveCode();

    expect(
      await screen.findByText("This pairing code has expired."),
    ).toBeInTheDocument();
  });

  it("pre-populates and resolves a linked code", async () => {
    const resolve = vi
      .spyOn(api, "resolvePairing")
      .mockResolvedValue(pairingRequest());
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    renderFlow({ initialCode: "k7q2xd" });

    expect(
      await screen.findByRole("heading", { name: "Review this player" }),
    ).toBeInTheDocument();
    expect(resolve).toHaveBeenCalledWith("K7Q2XD");
  });

  it("opens a pending request directly from its id", async () => {
    vi.spyOn(api, "pendingPairings").mockResolvedValue({
      items: [pairingRequest()],
      total: 1,
    });
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    renderFlow({ requestId: "pairing-1" });

    expect(
      await screen.findByRole("heading", { name: "Review this player" }),
    ).toBeInTheDocument();
  });

  it("reports an unknown pending request id", async () => {
    vi.spyOn(api, "pendingPairings").mockResolvedValue({ items: [], total: 0 });
    renderFlow({ requestId: "pairing-gone" });

    expect(
      await screen.findByText("No waiting player matches this code."),
    ).toBeInTheDocument();
  });
});

describe("PairScreenFlow new screen approval", () => {
  it("pairs with an explicit success state", async () => {
    const user = userEvent.setup();
    const onOpenScreen = vi.fn();
    const onClose = vi.fn();
    vi.spyOn(api, "resolvePairing").mockResolvedValue(pairingRequest());
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    const approve = vi
      .spyOn(api, "approvePairing")
      .mockResolvedValue(testScreen());
    renderFlow({ onOpenScreen, onClose });

    await resolveCode();
    await screen.findByRole("heading", { name: "Review this player" });
    await user.click(
      screen.getByRole("button", { name: "Approve and pair" }),
    );

    expect(
      await screen.findByRole("heading", { name: "“Lobby Display” paired" }),
    ).toBeInTheDocument();
    expect(approve).toHaveBeenCalledWith(
      "pairing-1",
      expect.objectContaining({
        name: "Google ADT-3",
        replaceExistingCredential: false,
      }),
      "csrf",
    );

    await user.click(screen.getByRole("button", { name: "Open screen" }));
    expect(onOpenScreen).toHaveBeenCalledWith("screen-9");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows approval failures inline", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "resolvePairing").mockResolvedValue(pairingRequest());
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "approvePairing").mockRejectedValue(
      new ApiError("The pairing session has expired.", 410, "pairing_expired"),
    );
    renderFlow();

    await resolveCode();
    await screen.findByRole("heading", { name: "Review this player" });
    await user.click(screen.getByRole("button", { name: "Approve and pair" }));

    expect(
      await screen.findByText("The pairing session has expired."),
    ).toBeInTheDocument();
  });
});

describe("PairScreenFlow credential repair", () => {
  it("repairs with the preserved screen name after confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "resolvePairing").mockResolvedValue(recognizedRequest());
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    const approve = vi
      .spyOn(api, "approvePairing")
      .mockResolvedValue(testScreen());
    renderFlow();

    await resolveCode();
    await screen.findByText("Reconnect to Lobby Display");
    expect(screen.queryByLabelText("Screen name")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Repair and replace credential" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", {
        name: "Repair and replace credential",
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "“Lobby Display” paired" }),
    ).toBeInTheDocument();
    expect(approve).toHaveBeenCalledWith(
      "pairing-1",
      expect.objectContaining({
        name: "Lobby Display",
        replaceExistingCredential: true,
      }),
      "csrf",
    );
  });

  it("leaves the pairing untouched when the repair is cancelled", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "resolvePairing").mockResolvedValue(recognizedRequest());
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    const approve = vi.spyOn(api, "approvePairing");
    renderFlow();

    await resolveCode();
    await screen.findByText("Reconnect to Lobby Display");
    await user.click(
      screen.getByRole("button", { name: "Repair and replace credential" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );

    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByText("Reconnect to Lobby Display")).toBeInTheDocument();
  });
});

describe("PairScreenFlow hardware replacement", () => {
  it("replaces hardware for the chosen screen after confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "resolvePairing").mockResolvedValue(pairingRequest());
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "screens").mockResolvedValue({
      items: [testScreen({ id: "screen-2", name: "Cafeteria Display" })],
      total: 1,
    });
    const approve = vi
      .spyOn(api, "approvePairing")
      .mockResolvedValue(testScreen({ id: "screen-2" }));
    renderFlow();

    await resolveCode();
    await screen.findByRole("heading", { name: "Review this player" });
    await user.click(
      screen.getByRole("button", { name: "Replacing an existing screen?" }),
    );
    await user.click(
      await screen.findByRole("combobox", { name: "Existing screen" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "Cafeteria Display" }),
    );
    await user.click(screen.getByRole("button", { name: "Replace hardware" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Replace hardware" }),
    );

    expect(
      await screen.findByRole("heading", { name: "“Lobby Display” paired" }),
    ).toBeInTheDocument();
    expect(approve).toHaveBeenCalledWith(
      "pairing-1",
      expect.objectContaining({
        replaceHardware: true,
        replacementScreenId: "screen-2",
      }),
      "csrf",
    );
  });

  it("requires choosing the replacement target first", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "resolvePairing").mockResolvedValue(pairingRequest());
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "screens").mockResolvedValue({ items: [], total: 0 });
    const approve = vi.spyOn(api, "approvePairing");
    renderFlow();

    await resolveCode();
    await screen.findByRole("heading", { name: "Review this player" });
    await user.click(
      screen.getByRole("button", { name: "Replacing an existing screen?" }),
    );
    await screen.findByRole("combobox", { name: "Existing screen" });
    await user.click(screen.getByRole("button", { name: "Replace hardware" }));

    expect(
      await screen.findByText(
        "Choose the existing screen whose hardware is being replaced.",
      ),
    ).toBeInTheDocument();
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("PairScreenFlow rejection", () => {
  it("rejects and closes the flow", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.spyOn(api, "resolvePairing").mockResolvedValue(pairingRequest());
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    const reject = vi.spyOn(api, "rejectPairing").mockResolvedValue(undefined);
    renderFlow({ onClose });

    await resolveCode();
    await screen.findByRole("heading", { name: "Review this player" });
    await user.click(screen.getByRole("button", { name: "Reject" }));

    expect(reject).toHaveBeenCalledWith(
      "pairing-1",
      "Rejected by administrator",
      "csrf",
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
