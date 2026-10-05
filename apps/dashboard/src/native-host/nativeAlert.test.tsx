// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConfirm, type ConfirmRequest } from "@/components/ConfirmDialog";
import { NativeHostProvider } from "./NativeHostProvider";

type Sent = { type: string; payload: Record<string, unknown> };

/** The iOS app's handler for the main page, answering like the app. */
function installNativeHost({
  nativeAlerts = true,
  alertReply = "ok",
}: { nativeAlerts?: boolean; alertReply?: "ok" | "unavailable" } = {}) {
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
          capabilities: { nativeNavigation: true, nativeAlerts },
        },
      });
    }
    if (message.type === "alert/present" && alertReply !== "ok") {
      return Promise.resolve({
        version: 1,
        ok: false,
        error: { code: alertReply },
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

function Delete({
  request,
  onResult,
}: {
  request: ConfirmRequest;
  onResult: (confirmed: boolean) => void;
}) {
  const { confirm, dialog } = useConfirm();
  return (
    <>
      <button
        type="button"
        onClick={() => void confirm(request).then(onResult)}
      >
        Delete
      </button>
      {dialog}
    </>
  );
}

const request: ConfirmRequest = {
  title: "Delete this schedule?",
  body: "Screens stop following it at once.",
  action: "Delete",
  destructive: true,
};

function renderDelete(onResult = vi.fn(), item: ConfirmRequest = request) {
  const view = render(
    <NativeHostProvider>
      <Delete request={item} onResult={onResult} />
    </NativeHostProvider>,
  );
  return { onResult, ...view };
}

async function ready(host: ReturnType<typeof installNativeHost>) {
  await waitFor(() => expect(host.types()).toContain("frontend/ready"));
}

function renderQueue() {
  let enqueue: ReturnType<typeof useConfirm>["confirm"] | undefined;
  function Queue() {
    const { confirm, dialog } = useConfirm();
    useEffect(() => {
      enqueue = confirm;
    }, [confirm]);
    return dialog;
  }
  const view = render(
    <StrictMode>
      <NativeHostProvider>
        <Queue />
      </NativeHostProvider>
    </StrictMode>,
  );
  return {
    ...view,
    confirm(item: ConfirmRequest) {
      if (!enqueue) throw new Error("confirmation hook is not mounted");
      return enqueue(item);
    },
  };
}

describe("confirmation queue", () => {
  it("settles simultaneous web requests in order without overwriting a caller", async () => {
    const view = renderQueue();
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    const firstResult = vi.fn();
    const secondResult = vi.fn();
    act(() => {
      first = view.confirm({ title: "First", action: "Proceed" });
      second = view.confirm({ title: "Second", action: "Proceed" });
      void first.then(firstResult);
      void second.then(secondResult);
    });
    expect(
      await screen.findByRole("alertdialog", { name: "First" }),
    ).toBeVisible();
    expect(secondResult).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Proceed" }));
    expect(await first).toBe(true);
    expect(
      await screen.findByRole("alertdialog", { name: "Second" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await second).toBe(false);
    expect(firstResult).toHaveBeenCalledExactlyOnceWith(true);
    expect(secondResult).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("Escape cancels only the visible request", async () => {
    const view = renderQueue();
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = view.confirm({ title: "First" });
      second = view.confirm({ title: "Second" });
    });
    await screen.findByRole("alertdialog", { name: "First" });
    await userEvent.keyboard("{Escape}");
    expect(await first).toBe(false);
    await screen.findByRole("alertdialog", { name: "Second" });
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await second).toBe(true);
  });

  it("unmount settles active and queued web requests, including retained callers", async () => {
    const view = renderQueue();
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = view.confirm({ title: "First" });
      second = view.confirm({ title: "Second" });
    });
    await screen.findByRole("alertdialog", { name: "First" });
    view.unmount();
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(await view.confirm({ title: "After unmount" })).toBe(false);
  });

  it("serializes native alerts and ignores duplicate responses", async () => {
    const host = installNativeHost();
    const view = renderQueue();
    await ready(host);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = view.confirm({ title: "First" });
      second = view.confirm({ title: "Second" });
    });
    await waitFor(() => expect(host.ofType("alert/present")).toHaveLength(1));
    const firstId = host.ofType("alert/present")[0]?.alertId;
    host.deliver("alert/action", { alertId: firstId, actionId: "cancel" });
    expect(await first).toBe(false);
    await waitFor(() => expect(host.ofType("alert/present")).toHaveLength(2));
    expect(
      host.deliver("alert/action", { alertId: firstId, actionId: "confirm" }),
    ).toBe(false);
    host.deliver("alert/action", {
      alertId: host.ofType("alert/present")[1]?.alertId,
      actionId: "confirm",
    });
    expect(await second).toBe(true);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("unmount withdraws the native alert and cancels requests still queued", async () => {
    const host = installNativeHost();
    const view = renderQueue();
    await ready(host);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = view.confirm({ title: "First" });
      second = view.confirm({ title: "Second" });
    });
    await waitFor(() => expect(host.ofType("alert/present")).toHaveLength(1));
    view.unmount();
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(host.ofType("alert/cancel")).toHaveLength(1);
    expect(host.ofType("alert/present")).toHaveLength(1);
  });

  it("keeps rich web confirmations ahead of queued native confirmations", async () => {
    const host = installNativeHost();
    const view = renderQueue();
    await ready(host);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = view.confirm({
        title: "First",
        body: <strong>Rich body</strong>,
      });
      second = view.confirm({ title: "Second" });
    });
    await screen.findByRole("alertdialog", { name: "First" });
    expect(host.ofType("alert/present")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await first).toBe(false);
    await waitFor(() => expect(host.ofType("alert/present")).toHaveLength(1));
    host.deliver("alert/action", {
      alertId: host.ofType("alert/present")[0]?.alertId,
      actionId: "confirm",
    });
    expect(await second).toBe(true);
  });
});

afterEach(() => {
  cleanup();
  delete window.webkit;
  delete window.tilecastNativeReceiver;
  vi.restoreAllMocks();
});

describe("confirmations as native alerts", () => {
  it("asks the host for an alert and resolves with the button chosen", async () => {
    const host = installNativeHost();
    const { onResult } = renderDelete();
    await ready(host);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(host.ofType("alert/present")).toHaveLength(1));
    const [alert] = host.ofType("alert/present") as [
      { alertId: string; actions: unknown[] },
    ];
    expect(alert).toEqual({
      alertId: expect.stringMatching(/^a-[0-9a-f]{32}$/) as unknown,
      title: "Delete this schedule?",
      message: "Screens stop following it at once.",
      actions: [
        { id: "cancel", label: "Cancel", role: "cancel" },
        { id: "confirm", label: "Delete", role: "destructive" },
      ],
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();

    expect(
      host.deliver("alert/action", {
        alertId: alert.alertId,
        actionId: "confirm",
      }),
    ).toBe(true);
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it("resolves false when the user cancels", async () => {
    const host = installNativeHost();
    const { onResult } = renderDelete();
    await ready(host);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(host.ofType("alert/present")).toHaveLength(1));
    host.deliver("alert/action", {
      alertId: (host.ofType("alert/present")[0] as { alertId: string }).alertId,
      actionId: "cancel",
    });
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it("ignores a choice for an alert it did not present", async () => {
    const host = installNativeHost();
    const { onResult } = renderDelete();
    await ready(host);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(host.ofType("alert/present")).toHaveLength(1));
    expect(
      host.deliver("alert/action", {
        alertId: "a-somebody-else",
        actionId: "confirm",
      }),
    ).toBe(false);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("shows the web dialog when the host refuses the alert", async () => {
    const host = installNativeHost({ alertReply: "unavailable" });
    const { onResult } = renderDelete();
    await ready(host);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it("shows the web dialog when the host has no alerts", async () => {
    const host = installNativeHost({ nativeAlerts: false });
    renderDelete();
    await ready(host);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    expect(host.types()).not.toContain("alert/present");
  });

  it("shows the web dialog in a browser", async () => {
    renderDelete();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alertdialog")).toBeVisible();
  });

  it("uses the web dialog for a body that is not plain text", async () => {
    const host = installNativeHost();
    renderDelete(vi.fn(), { ...request, body: <strong>Rich</strong> });
    await ready(host);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    expect(host.types()).not.toContain("alert/present");
  });

  it("sends no message and no button label when the body is absent", async () => {
    const host = installNativeHost();
    renderDelete(vi.fn(), { title: "Discard changes?" });
    await ready(host);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(host.ofType("alert/present")).toHaveLength(1));
    const payload = host.ofType("alert/present")[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("message");
    expect(payload.actions).toEqual([
      { id: "cancel", label: "Cancel", role: "cancel" },
      { id: "confirm", label: "Confirm", role: "default" },
    ]);
  });

  it("withdraws the alert when its owner goes away", async () => {
    const host = installNativeHost();
    const { unmount, onResult } = renderDelete();
    await ready(host);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(host.ofType("alert/present")).toHaveLength(1));
    const { alertId } = host.ofType("alert/present")[0] as {
      alertId: string;
    };
    unmount();
    await waitFor(() =>
      expect(host.ofType("alert/cancel")).toEqual([{ alertId }]),
    );
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });
});
