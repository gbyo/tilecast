// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeHostProvider } from "../../native-host/NativeHostProvider";
import {
  ActionContextMenu,
  ActionMenuButton,
  type StudioActionGroup,
} from "./ActionMenu";

type Sent = { type: string; payload: Record<string, unknown> };

/** The iOS app's handler for the main page, answering like the app. */
function installNativeHost({
  presentReply = "ok",
}: { presentReply?: "ok" | "unavailable" } = {}) {
  const sent: Sent[] = [];
  const postMessage = vi.fn((message: Sent) => {
    sent.push(structuredClone(message));
    if (message.type === "config/get") {
      return Promise.resolve({
        version: 1,
        ok: true,
        payload: {
          protocolVersion: 1,
          context: "main",
          capabilities: { nativeNavigation: true, nativeActionMenus: true },
        },
      });
    }
    if (message.type === "action-menu/present" && presentReply !== "ok") {
      return Promise.resolve({
        version: 1,
        ok: false,
        error: { code: presentReply },
      });
    }
    return Promise.resolve({ version: 1, ok: true, payload: {} });
  });
  window.webkit = { messageHandlers: { tilecastNative: { postMessage } } };
  return {
    ofType: (type: string) =>
      sent.filter((message) => message.type === type).map((m) => m.payload),
    types: () => sent.map((message) => message.type),
    deliver(type: string, payload: Record<string, unknown>) {
      let accepted: boolean | undefined;
      act(() => {
        accepted = window.tilecastNativeReceiver?.({
          version: 1,
          type,
          payload,
        });
      });
      return accepted;
    },
  };
}

async function ready(host: ReturnType<typeof installNativeHost>) {
  await waitFor(() => expect(host.types()).toContain("frontend/ready"));
}

afterEach(() => {
  cleanup();
  delete window.webkit;
  delete window.tilecastNativeReceiver;
  vi.restoreAllMocks();
});

function groups(listeners: {
  onOpen?: () => void;
  onDelete?: () => void;
}): StudioActionGroup[] {
  return [
    {
      actions: [
        {
          id: "open",
          label: "Open",
          icon: "open",
          onSelect: listeners.onOpen ?? (() => {}),
        },
      ],
    },
    {
      actions: [
        {
          id: "delete",
          label: "Delete",
          icon: "trash",
          role: "destructive",
          onSelect: listeners.onDelete ?? (() => {}),
        },
      ],
    },
  ];
}

function renderButton(actions: StudioActionGroup[]) {
  return render(
    <StrictMode>
      <NativeHostProvider>
        <ActionMenuButton label="Actions for Lobby" actions={actions} />
      </NativeHostProvider>
    </StrictMode>,
  );
}

describe("ActionMenuButton in a browser", () => {
  it("opens the web menu with grouped actions", async () => {
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    renderButton(groups({ onOpen, onDelete }));
    expect(
      screen.queryByRole("menuitem", { name: "Open" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Lobby" }),
    );
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
    expect(onDelete).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("menuitem", { name: "Open" }),
    ).not.toBeInTheDocument();
  });

  it("opens the web menu synchronously without a native host", () => {
    renderButton(groups({}));
    fireEvent.click(screen.getByRole("button", { name: "Actions for Lobby" }));
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  });

  it("opens with the keyboard and closes with Escape", async () => {
    renderButton(groups({}));
    screen.getByRole("button", { name: "Actions for Lobby" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "Open" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("menuitem", { name: "Open" }),
    ).not.toBeInTheDocument();
  });

  it("disables actions and skips empty groups without a separator", async () => {
    renderButton([
      { actions: [] },
      {
        actions: [
          {
            id: "rename",
            label: "Rename",
            disabled: true,
            onSelect: () => {},
          },
        ],
      },
      {
        actions: [{ id: "open", label: "Open", onSelect: () => {} }],
      },
    ]);
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Lobby" }),
    );
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("renders an unknown icon token as text only", async () => {
    renderButton([
      {
        actions: [
          {
            id: "open",
            label: "Open",
            icon: "not-a-token",
            onSelect: () => {},
          },
        ],
      },
    ]);
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Lobby" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Open" }).querySelector("svg"),
    ).toBeNull();
  });

  it("renders nothing without actions", () => {
    renderButton([{ actions: [] }]);
    expect(
      screen.queryByRole("button", { name: "Actions for Lobby" }),
    ).not.toBeInTheDocument();
  });
});

describe("ActionMenuButton with a native host", () => {
  it("uses the native menu and invokes the chosen callback", async () => {
    const host = installNativeHost();
    const onDelete = vi.fn();
    renderButton(groups({ onDelete }));
    await ready(host);
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Lobby" }),
    );
    await waitFor(() =>
      expect(host.ofType("action-menu/present")).toHaveLength(1),
    );
    expect(
      screen.queryByRole("menuitem", { name: "Delete" }),
    ).not.toBeInTheDocument();
    const menuId = (host.ofType("action-menu/present")[0] as { menuId: string })
      .menuId;
    host.deliver("action-menu/action", { menuId, actionId: "delete" });
    await waitFor(() => expect(onDelete).toHaveBeenCalledExactlyOnceWith());
    expect(
      screen.queryByRole("menuitem", { name: "Delete" }),
    ).not.toBeInTheDocument();
  });

  it("does nothing when the native menu is dismissed", async () => {
    const host = installNativeHost();
    const onDelete = vi.fn();
    renderButton(groups({ onDelete }));
    await ready(host);
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Lobby" }),
    );
    await waitFor(() =>
      expect(host.ofType("action-menu/present")).toHaveLength(1),
    );
    const menuId = (host.ofType("action-menu/present")[0] as { menuId: string })
      .menuId;
    host.deliver("action-menu/dismissed", { menuId });
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", { name: "Delete" }),
      ).not.toBeInTheDocument(),
    );
    expect(onDelete).not.toHaveBeenCalled();
    // The trigger still works afterwards.
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Lobby" }),
    );
    await waitFor(() =>
      expect(host.ofType("action-menu/present")).toHaveLength(2),
    );
  });

  it("falls back to the web menu when the host refuses", async () => {
    const host = installNativeHost({ presentReply: "unavailable" });
    const onOpen = vi.fn();
    renderButton(groups({ onOpen }));
    await ready(host);
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Lobby" }),
    );
    expect(await screen.findByRole("menuitem", { name: "Open" })).toBeVisible();
    await userEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
  });
});

describe("ActionContextMenu", () => {
  function renderCard(actions: StudioActionGroup[]) {
    return render(
      <StrictMode>
        <NativeHostProvider>
          <ActionContextMenu label="Actions for Lobby" actions={actions}>
            <div data-testid="card">Lobby</div>
          </ActionContextMenu>
        </NativeHostProvider>
      </StrictMode>,
    );
  }

  it("opens the web menu on right-click", async () => {
    const onOpen = vi.fn();
    renderCard(groups({ onOpen }));
    fireEvent.contextMenu(screen.getByTestId("card"));
    expect(await screen.findByRole("menuitem", { name: "Open" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await userEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
  });

  it("arms on press and disarms on release, cancel, and scroll", async () => {
    const host = installNativeHost();
    renderCard(groups({}));
    await ready(host);
    const card = screen.getByTestId("card");
    fireEvent.pointerDown(card);
    await waitFor(() => expect(host.ofType("action-menu/arm")).toHaveLength(1));
    const menuId = (host.ofType("action-menu/arm")[0] as { menuId: string })
      .menuId;
    expect((host.ofType("action-menu/arm")[0] as { label: string }).label).toBe(
      "Actions for Lobby",
    );
    fireEvent.pointerUp(card);
    await waitFor(() =>
      expect(host.ofType("action-menu/disarm")).toEqual([{ menuId }]),
    );

    fireEvent.pointerDown(card);
    await waitFor(() => expect(host.ofType("action-menu/arm")).toHaveLength(2));
    fireEvent.pointerCancel(card);
    await waitFor(() =>
      expect(host.ofType("action-menu/disarm")).toHaveLength(2),
    );

    fireEvent.pointerDown(card);
    await waitFor(() => expect(host.ofType("action-menu/arm")).toHaveLength(3));
    fireEvent.scroll(window);
    await waitFor(() =>
      expect(host.ofType("action-menu/disarm")).toHaveLength(3),
    );
  });

  it("renders children without a menu when there are no actions", async () => {
    const host = installNativeHost();
    renderCard([{ actions: [] }]);
    await ready(host);
    fireEvent.pointerDown(screen.getByTestId("card"));
    fireEvent.contextMenu(screen.getByTestId("card"));
    expect(host.ofType("action-menu/arm")).toHaveLength(0);
    expect(
      screen.queryByRole("menuitem", { name: "Open" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("card")).toBeVisible();
  });
});
