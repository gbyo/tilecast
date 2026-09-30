// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryRouter,
  MemoryRouter,
  RouterProvider,
  type RouteObject,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import type { Screen, UpdateDeploymentDetail } from "@/api/types";
import { NativeHostProvider } from "@/native-host/NativeHostProvider";
import { ActivityIncidentPresentation } from "@/pages/ActivityIncidentPresentation";
import { IncidentsTab } from "@/pages/ActivityIncidentsTab";
import { UpdateDeploymentPresentation } from "@/settings/UpdateDeploymentPresentation";
import { NativePresentationHost } from "./NativePresentationHost";

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    isLoading: false,
    status: {
      authenticated: true,
      csrfToken: "csrf",
      user: { id: "user-1", name: "Owner", role: "owner" },
    },
  }),
}));

type Sent = { type: string; payload: Record<string, unknown> };

/** The iOS app's handler for one page, answering like the app. */
function installNativeHost(context: "main" | "presentation") {
  const sent: Sent[] = [];
  const postMessage = vi.fn((message: Sent) => {
    sent.push(structuredClone(message));
    if (message.type === "config/get") {
      return Promise.resolve({
        version: 1,
        ok: true,
        payload: {
          protocolVersion: 1,
          context,
          capabilities: {
            nativeNavigation: context === "main",
            nativePresentations: true,
          },
        },
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
      act(() => {
        window.tilecastNativeReceiver?.({ version: 1, type, payload });
      });
    },
  };
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderPresentationRoutes(children: RouteObject[]) {
  const router = createMemoryRouter(
    [
      {
        path: "/__native/modal",
        element: <NativePresentationHost routes={children} />,
        children,
      },
    ],
    { initialEntries: ["/__native/modal"] },
  );
  render(
    <QueryClientProvider client={client()}>
      <NativeHostProvider>
        <RouterProvider router={router} />
      </NativeHostProvider>
    </QueryClientProvider>,
  );
}

async function show(host: ReturnType<typeof installNativeHost>, path: string) {
  await waitFor(() => expect(host.types()).toContain("presentation/ready"));
  host.deliver("presentation/show", { presentationId: "p-1", path });
}

afterEach(() => {
  cleanup();
  delete window.webkit;
  delete window.tilecastNativeReceiver;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const incident = {
  id: "incident-1",
  incidentType: "connectivity",
  severity: "critical",
  status: "open",
  title: "Screen stopped reporting",
  description: "The Player stopped reporting.",
  openedAt: "2026-07-26T09:00:00.000Z",
  lastSeenAt: "2026-07-26T09:40:00.000Z",
  primaryScreenId: "screen-1",
  primaryScreenName: "Lobby north",
  affectedScreens: 1,
  occurrenceCount: 3,
  failureCode: "heartbeat_gap",
};

const incidentDetail = {
  ...incident,
  recoveryPath: "Not recovered yet.",
  timeline: [],
  screens: [],
  relatedEvents: [],
  proofSessions: [],
  auditChanges: [],
};

function stubIncidentApi() {
  const patched: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === "PATCH") {
        patched.push(JSON.parse(init.body as string));
        return Promise.resolve(
          new Response(JSON.stringify({ data: {} }), { status: 200 }),
        );
      }
      const body = url.includes("/incidents/incident-1")
        ? { data: incidentDetail }
        : { data: { items: [incident] } };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
  return patched;
}

describe("activity incident details as a native presentation", () => {
  const children: RouteObject[] = [
    {
      path: "activity-incident/:id",
      element: <ActivityIncidentPresentation />,
    },
  ];

  it("renders the evidence and describes the native header", async () => {
    stubIncidentApi();
    const host = installNativeHost("presentation");
    renderPresentationRoutes(children);
    await show(host, "/__native/modal/activity-incident/incident-1");
    expect(await screen.findByText("Not recovered yet.")).toBeVisible();
    expect(screen.getByText("The Player stopped reporting.")).toBeVisible();
    await waitFor(() =>
      expect(host.ofType("presentation/update")).toContainEqual({
        presentationId: "p-1",
        header: {
          title: "Screen stopped reporting",
          navigation: "close",
          navigationLabel: "Close",
        },
        size: "full",
      }),
    );
  });

  it("applies an action, then closes the sheet", async () => {
    const patched = stubIncidentApi();
    const host = installNativeHost("presentation");
    renderPresentationRoutes(children);
    await show(host, "/__native/modal/activity-incident/incident-1");
    await userEvent.click(
      await screen.findByRole("button", { name: "Acknowledge" }),
    );
    await waitFor(() =>
      expect(patched).toEqual([
        expect.objectContaining({ action: "acknowledge" }),
      ]),
    );
    await waitFor(() =>
      expect(host.ofType("presentation/close")).toEqual([
        { presentationId: "p-1" },
      ]),
    );
  });

  it("asks a native host to present an incident from the list", async () => {
    stubIncidentApi();
    vi.spyOn(api, "screens").mockResolvedValue({ items: [] } as never);
    const host = installNativeHost("main");
    render(
      <QueryClientProvider client={client()}>
        <NativeHostProvider>
          <MemoryRouter>
            <IncidentsTab
              range={{ from: "", to: "", label: "today" }}
              filters={{}}
              hasActiveFilters={false}
              onClearFilters={() => {}}
            />
          </MemoryRouter>
        </NativeHostProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(host.types()).toContain("frontend/ready"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Details" }),
    );
    await waitFor(() =>
      expect(host.ofType("presentation/open")).toEqual([
        expect.objectContaining({
          path: "/__native/modal/activity-incident/incident-1",
          title: "Screen stopped reporting",
          size: "full",
        }),
      ]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the web drawer in a browser", async () => {
    stubIncidentApi();
    vi.spyOn(api, "screens").mockResolvedValue({ items: [] } as never);
    render(
      <QueryClientProvider client={client()}>
        <NativeHostProvider>
          <MemoryRouter>
            <IncidentsTab
              range={{ from: "", to: "", label: "today" }}
              filters={{}}
              hasActiveFilters={false}
              onClearFilters={() => {}}
            />
          </MemoryRouter>
        </NativeHostProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Details" }),
    );
    expect(await screen.findByRole("dialog")).toBeVisible();
  });
});

const deployment: UpdateDeploymentDetail = {
  id: "d1",
  name: "Tilecast Player 1.4.0",
  mode: "install_now",
  status: "active",
  createdAt: "2026-07-30T11:00:00Z",
  platform: "android",
  versionCode: 42,
  versionName: "1.4.0",
  artifactSizeBytes: 40 * 1024 * 1024,
  rolloutMode: "canary",
  rolloutPhase: "canary",
  canarySize: 2,
  screens: [
    {
      screenId: "s3",
      screenName: "Gym",
      previousVersionCode: 41,
      expectedVersionCode: 42,
      downloadedBytes: 0,
      state: "failed",
      safeError: "Not enough storage on the device.",
      updatedAt: "2026-07-30T11:45:00Z",
      isCanary: false,
    },
  ],
};

describe("update deployment status as a native presentation", () => {
  const children: RouteObject[] = [
    {
      path: "update-deployment/:id",
      element: <UpdateDeploymentPresentation />,
    },
  ];

  beforeEach(() => {
    vi.spyOn(api, "updateDeployment").mockResolvedValue(deployment);
    vi.spyOn(api, "screens").mockResolvedValue({
      items: [{ id: "s3", name: "Gym", status: "offline" } as Screen],
    } as never);
  });

  it("loads the deployment by id and describes the native header", async () => {
    const host = installNativeHost("presentation");
    renderPresentationRoutes(children);
    await show(host, "/__native/modal/update-deployment/d1");
    expect(await screen.findByText("Gym")).toBeVisible();
    expect(api.updateDeployment).toHaveBeenCalledWith("d1");
    await waitFor(() =>
      expect(host.ofType("presentation/update")).toContainEqual({
        presentationId: "p-1",
        header: {
          title: "Tilecast Player 1.4.0",
          subtitle: "Android · 1.4.0 (42)",
          navigation: "close",
          navigationLabel: "Close",
        },
        size: "full",
      }),
    );
  });

  it("retries a failed screen and cancels the deployment", async () => {
    const retry = vi
      .spyOn(api, "retryUpdateScreen")
      .mockResolvedValue({ state: "pending" });
    const cancel = vi
      .spyOn(api, "cancelUpdateDeployment")
      .mockResolvedValue({ id: "d1", status: "cancelled" });
    const host = installNativeHost("presentation");
    renderPresentationRoutes(children);
    await show(host, "/__native/modal/update-deployment/d1");
    await screen.findByText("Gym");
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("d1", "s3", "csrf"));
    await userEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("d1", "csrf"));
  });
});
