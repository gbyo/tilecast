// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeHostProvider } from "./NativeHostProvider";
import {
  useNativeActionMenu,
  type NativeMenuGroup,
} from "./useNativeActionMenu";

type Sent = { type: string; payload: Record<string, unknown> };

/** The iOS app's handler for the main page, answering like the app. */
function installNativeHost({
  nativeActionMenus = true,
  presentReply = "ok",
}: {
  nativeActionMenus?: boolean;
  presentReply?: "ok" | "unavailable";
} = {}) {
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
          capabilities: { nativeNavigation: true, nativeActionMenus },
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

function renderMenu() {
  let handle: ReturnType<typeof useNativeActionMenu> | undefined;
  function Probe() {
    const menus = useNativeActionMenu();
    useEffect(() => {
      handle = menus;
    }, [menus]);
    return null;
  }
  const view = render(
    <StrictMode>
      <NativeHostProvider>
        <Probe />
      </NativeHostProvider>
    </StrictMode>,
  );
  const menus = () => {
    if (!handle) throw new Error("menu hook is not mounted");
    return handle;
  };
  return { ...view, menus };
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

const groups = (listeners: {
  onOpen?: () => void;
  onDelete?: () => void;
}): NativeMenuGroup[] => [
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

describe("native action menus", () => {
  it("reports unavailable in a browser and arms nothing", async () => {
    const view = renderMenu();
    const onOpen = vi.fn();
    expect(await view.menus().present("Actions", groups({ onOpen }))).toEqual({
      outcome: "unavailable",
    });
    expect(view.menus().arm("Actions", groups({ onOpen }))).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("presents a serializable descriptor and invokes the chosen callback", async () => {
    const host = installNativeHost();
    const view = renderMenu();
    await ready(host);
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    let result!: ReturnType<typeof view.menus.present>;
    act(() => {
      result = view.menus().present(
        "Actions for Lobby",
        groups({ onOpen, onDelete }),
      );
    });
    await waitFor(() =>
      expect(host.ofType("action-menu/present")).toHaveLength(1),
    );
    const sent = host.ofType("action-menu/present")[0] as Record<string, unknown>;
    expect(sent["label"]).toBe("Actions for Lobby");
    expect(sent["groups"]).toEqual([
      { items: [{ id: "open", label: "Open", icon: "open" }] },
      {
        items: [
          { id: "delete", label: "Delete", icon: "trash", role: "destructive" },
        ],
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain("onSelect");
    expect(
      host.deliver("action-menu/action", {
        menuId: sent["menuId"],
        actionId: "delete",
      }),
    ).toBe(true);
    await expect(result).resolves.toEqual({
      outcome: "action",
      actionId: "delete",
    });
    expect(onDelete).toHaveBeenCalledExactlyOnceWith();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("drops empty groups and refuses to present a menu without actions", async () => {
    const host = installNativeHost();
    const view = renderMenu();
    await ready(host);
    const onOpen = vi.fn();
    let result!: ReturnType<typeof view.menus.present>;
    act(() => {
      result = view.menus().present("Actions", [
        { actions: [] },
        { actions: [{ id: "open", label: "Open", onSelect: onOpen }] },
      ]);
    });
    await waitFor(() =>
      expect(host.ofType("action-menu/present")).toHaveLength(1),
    );
    expect(host.ofType("action-menu/present")[0]?.groups).toEqual([
      { items: [{ id: "open", label: "Open" }] },
    ]);
    expect(
      host.deliver("action-menu/dismissed", {
        menuId: (host.ofType("action-menu/present")[0] as { menuId: string })
          .menuId,
      }),
    ).toBe(true);
    await expect(result).resolves.toEqual({ outcome: "dismissed" });

    await expect(
      view.menus().present("Actions", [{ actions: [] }]),
    ).resolves.toEqual({ outcome: "unavailable" });
    expect(host.ofType("action-menu/present")).toHaveLength(1);
  });

  it("falls back when the host refuses, and ignores a late answer", async () => {
    const host = installNativeHost({ presentReply: "unavailable" });
    const view = renderMenu();
    await ready(host);
    const onOpen = vi.fn();
    await expect(
      view.menus().present("Actions", groups({ onOpen })),
    ).resolves.toEqual({ outcome: "unavailable" });
    const menuId = (
      host.ofType("action-menu/present")[0] as { menuId: string } | undefined
    )?.menuId;
    expect(
      host.deliver("action-menu/action", { menuId, actionId: "open" }),
    ).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("reports unavailable to an older host without the capability", async () => {
    const host = installNativeHost({ nativeActionMenus: false });
    const view = renderMenu();
    await ready(host);
    const onOpen = vi.fn();
    await expect(
      view.menus().present("Actions", groups({ onOpen })),
    ).resolves.toEqual({ outcome: "unavailable" });
    expect(view.menus().arm("Actions", groups({ onOpen }))).toBeNull();
    expect(host.types()).not.toContain("action-menu/present");
  });

  it("ignores a stale menu, a stale action, and a disabled action", async () => {
    const host = installNativeHost();
    const view = renderMenu();
    await ready(host);
    const onOpen = vi.fn();
    let result!: ReturnType<typeof view.menus.present>;
    act(() => {
      result = view.menus().present("Actions", [
        {
          actions: [
            { id: "open", label: "Open", onSelect: onOpen },
            { id: "archived", label: "Archived", disabled: true, onSelect: () => {} },
          ],
        },
      ]);
    });
    await waitFor(() =>
      expect(host.ofType("action-menu/present")).toHaveLength(1),
    );
    const menuId = (
      host.ofType("action-menu/present")[0] as { menuId: string }
    ).menuId;
    expect(
      host.deliver("action-menu/action", {
        menuId: "m-someone-elses-menu",
        actionId: "open",
      }),
    ).toBe(false);
    expect(
      host.deliver("action-menu/action", { menuId, actionId: "nope" }),
    ).toBe(false);
    expect(
      host.deliver("action-menu/action", { menuId, actionId: "archived" }),
    ).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
    expect(
      host.deliver("action-menu/action", { menuId, actionId: "open" }),
    ).toBe(true);
    await expect(result).resolves.toEqual({
      outcome: "action",
      actionId: "open",
    });
    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
  });

  it("never executes menu B from a response for menu A", async () => {
    const host = installNativeHost();
    const handles: ReturnType<typeof useNativeActionMenu>[] = [];
    function Probe() {
      const menus = useNativeActionMenu();
      useEffect(() => {
        handles.push(menus);
      }, [menus]);
      return null;
    }
    // No StrictMode: each probe's handle is captured exactly once.
    render(
      <NativeHostProvider>
        <Probe />
        <Probe />
      </NativeHostProvider>,
    );
    await ready(host);
    const [first, second] = handles as [
      ReturnType<typeof useNativeActionMenu>,
      ReturnType<typeof useNativeActionMenu>,
    ];
    const onDelete = vi.fn();
    const onOpen = vi.fn();
    let firstResult!: ReturnType<typeof first.present>;
    let secondResult!: ReturnType<typeof second.present>;
    act(() => {
      firstResult = first!.present("First", groups({ onDelete }));
      secondResult = second!.present("Second", groups({ onOpen }));
    });
    await waitFor(() =>
      expect(host.ofType("action-menu/present")).toHaveLength(2),
    );
    const [firstSent, secondSent] = host.ofType("action-menu/present") as {
      menuId: string;
    }[];
    expect(
      host.deliver("action-menu/action", {
        menuId: firstSent?.menuId,
        actionId: "open",
      }),
    ).toBe(true);
    await expect(firstResult).resolves.toEqual({
      outcome: "action",
      actionId: "open",
    });
    expect(onOpen).not.toHaveBeenCalled();
    expect(
      host.deliver("action-menu/action", {
        menuId: secondSent?.menuId,
        actionId: "open",
      }),
    ).toBe(true);
    await expect(secondResult).resolves.toEqual({
      outcome: "action",
      actionId: "open",
    });
    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("unmount withdraws a presented menu and a late answer does nothing", async () => {
    const host = installNativeHost();
    const view = renderMenu();
    await ready(host);
    const onOpen = vi.fn();
    let result!: ReturnType<typeof view.menus.present>;
    act(() => {
      result = view.menus().present("Actions", groups({ onOpen }));
    });
    await waitFor(() =>
      expect(host.ofType("action-menu/present")).toHaveLength(1),
    );
    const menuId = (host.ofType("action-menu/present")[0] as { menuId: string })
      .menuId;
    view.unmount();
    await expect(result).resolves.toEqual({ outcome: "dismissed" });
    expect(host.ofType("action-menu/disarm")).toEqual([{ menuId }]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("arms a context menu and a disarm still lets a built menu answer", async () => {
    const host = installNativeHost();
    const view = renderMenu();
    await ready(host);
    const onOpen = vi.fn();
    let disarm!: (() => void) | null;
    act(() => {
      disarm = view.menus().arm("Actions", groups({ onOpen }));
    });
    await waitFor(() => expect(host.ofType("action-menu/arm")).toHaveLength(1));
    const menuId = (host.ofType("action-menu/arm")[0] as { menuId: string })
      .menuId;
    expect(disarm).not.toBeNull();
    act(() => disarm?.());
    expect(host.ofType("action-menu/disarm")).toEqual([{ menuId }]);
    // The host built the menu before the disarm arrived, so the choice
    // still counts.
    expect(
      host.deliver("action-menu/action", { menuId, actionId: "open" }),
    ).toBe(true);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith();
  });

  it("each arm supersedes the previous one", async () => {
    const host = installNativeHost();
    const view = renderMenu();
    await ready(host);
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    act(() => {
      view.menus().arm("First", groups({ onOpen: onFirst }));
    });
    await waitFor(() => expect(host.ofType("action-menu/arm")).toHaveLength(1));
    const firstId = (host.ofType("action-menu/arm")[0] as { menuId: string })
      .menuId;
    act(() => {
      view.menus().arm("Second", groups({ onOpen: onSecond }));
    });
    await waitFor(() => expect(host.ofType("action-menu/arm")).toHaveLength(2));
    expect(host.ofType("action-menu/disarm")).toEqual([{ menuId: firstId }]);
    expect(
      host.deliver("action-menu/action", {
        menuId: firstId,
        actionId: "open",
      }),
    ).toBe(false);
    expect(onFirst).not.toHaveBeenCalled();
    const secondId = (host.ofType("action-menu/arm")[1] as { menuId: string })
      .menuId;
    expect(
      host.deliver("action-menu/action", {
        menuId: secondId,
        actionId: "open",
      }),
    ).toBe(true);
    expect(onSecond).toHaveBeenCalledExactlyOnceWith();
  });

  it("unmount disarms an armed menu", async () => {
    const host = installNativeHost();
    const view = renderMenu();
    await ready(host);
    act(() => {
      view.menus().arm("Actions", groups({}));
    });
    await waitFor(() => expect(host.ofType("action-menu/arm")).toHaveLength(1));
    const menuId = (host.ofType("action-menu/arm")[0] as { menuId: string })
      .menuId;
    view.unmount();
    expect(host.ofType("action-menu/disarm")).toEqual([{ menuId }]);
  });
});
