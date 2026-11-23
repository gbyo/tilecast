// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { afterEach, describe, expect, it, vi } from "vitest";
import countdown from "../../../../../plugins/countdown-bar/tilecast.plugin.json";
import { chooseOption, renderPluginRoute, stubStudioApi } from "../testing";
import { HostedInstanceEditor } from "./HostedInstanceEditor";
import { HostedInstancesPage } from "./HostedInstancesPage";
import {
  configDefaults,
  formProblems,
  newFormState,
  requestBody,
  type HostedKind,
} from "./model";

const manifest = countdown as unknown as PluginManifestV3;
const kind = manifest.instances[0] as HostedKind;
const base = "/plugins/countdown-bar";

const stored = {
  id: "bar-1",
  kind: "instance",
  name: "Lunch",
  enabled: true,
  priority: 3,
  targetScope: "all",
  targetIds: [],
  revision: 4,
  message: "Lunch ends in",
  scheduleType: "weekly",
  targetTime: "12:00",
  daysOfWeek: [1, 3],
  timezone: "America/New_York",
  leadTimeSeconds: 900,
  displayMode: "overlay",
  heightPx: 72,
  progressFill: "drain",
  contentPadding: 2,
  textScale: 125,
  showConfetti: true,
  urgencyEnabled: true,
  startingSoonSeconds: 300,
  urgentSeconds: 60,
  pulseSeconds: 10,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function editor(path: string, role = "owner") {
  return renderPluginRoute(
    <HostedInstanceEditor pluginId="countdown_bar" manifest={manifest} />,
    { path, role, patterns: [`${base}/new`, `${base}/:id`] },
  );
}

describe("hosted instance model", () => {
  it("applies the schema defaults and the organization's time zone", () => {
    const defaults = configDefaults(kind.fields, "America/Chicago");
    expect(defaults).toMatchObject({
      message: "Lunch ends in",
      scheduleType: "weekly",
      daysOfWeek: [1, 2, 3, 4, 5],
      timezone: "America/Chicago",
      leadTimeSeconds: 900,
      heightPx: 72,
      contentPadding: 4,
      textScale: 100,
      startingSoonSeconds: 300,
      urgentSeconds: 60,
      pulseSeconds: 10,
    });
  });

  it("sends the host members, drops cleared fields, and names the revision", () => {
    const form = {
      ...newFormState(kind, "UTC"),
      name: " Lunch ",
      targetScope: "screens" as const,
      targetIds: ["screen-1"],
    };
    form.config = { ...form.config, fontId: undefined, completionText: "" };
    const body = requestBody(kind, form, 7);
    expect(body).toMatchObject({
      name: "Lunch",
      enabled: true,
      priority: 0,
      targetScope: "screens",
      targetIds: ["screen-1"],
      expectedRevision: 7,
      fontId: null,
      completionText: null,
    });
    expect(requestBody(kind, form)).not.toHaveProperty("expectedRevision");
    // The unscoped target sends no ids even if some were chosen before.
    expect(
      requestBody(kind, { ...form, targetScope: "all" }).targetIds,
    ).toEqual([]);
  });

  it("reports a missing name, an empty target list, and an invalid value early", () => {
    const messages = {
      name: "name",
      targets: "targets",
      secretRequired: (label: string) => label,
    };
    const form = newFormState(kind, "UTC");
    expect(
      formProblems(kind, { ...form, name: "x" }, undefined, messages),
    ).toEqual([]);
    expect(
      formProblems(
        kind,
        { ...form, targetScope: "screens" },
        undefined,
        messages,
      ).map((problem) => problem.path),
    ).toEqual(["name", "targets"]);
    const tooTall = {
      ...form,
      name: "x",
      config: { ...form.config, heightPx: 999 },
    };
    expect(formProblems(kind, tooTall, undefined, messages)[0]?.path).toBe(
      "heightPx",
    );
  });
});

describe("hosted instance editor for Countdown Bar", () => {
  it("shows every setting the old editor had, and the urgency stages only when enabled", async () => {
    stubStudioApi({ installed: ["countdown_bar"] });
    editor(`${base}/new`);
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    for (const label of [
      "Message",
      "Optional completion text",
      "Show confetti when the countdown reaches zero",
      "Schedule",
      "Target time",
      "Timezone",
      "Appear this many minutes before",
      "Mode",
      "Bottom-bar height (px)",
      "Background countdown",
      "Horizontal padding (%)",
      "Text size (%)",
      "Enable countdown urgency stages",
    ])
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Priority")).toBeInTheDocument();
    expect(screen.getByLabelText("Target type")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Sun" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByText(/Urgent \(red\)/)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("switch", { name: "Enable countdown urgency stages" }),
    );
    expect(
      await screen.findByText(/Urgent \(red\), seconds before/),
    ).toBeVisible();
    // The one-time fields replace the weekly ones.
    fireEvent.click(screen.getByRole("radio", { name: "One-time date" }));
    expect(await screen.findByText("Target date and time")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Mon" }),
    ).not.toBeInTheDocument();
  }, 15_000);

  it("creates an instance with the defaults, in minutes for lead time", async () => {
    const { submitted } = stubStudioApi({ installed: ["countdown_bar"] });
    editor(`${base}/new`);
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Lunch" },
    });
    expect(
      screen.getByLabelText(/Appear this many minutes before/),
    ).toHaveValue(15);
    fireEvent.change(screen.getByLabelText(/Appear this many minutes before/), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Wed" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      name: "Lunch",
      enabled: true,
      priority: 0,
      targetScope: "all",
      targetIds: [],
      leadTimeSeconds: 1200,
      daysOfWeek: [1, 2, 4, 5],
      scheduleType: "weekly",
      displayMode: "overlay",
    });
    expect(submitted[0]).not.toHaveProperty("expectedRevision");
  }, 15_000);

  it("requires a target when a scope is chosen", async () => {
    stubStudioApi({ installed: ["countdown_bar"] });
    editor(`${base}/new`);
    await waitFor(() =>
      expect(screen.getByLabelText("Target type")).toBeEnabled(),
    );
    await chooseOption("Target type", "Individual screens");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Lunch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Choose at least one target."),
    ).toBeVisible();
  }, 15_000);

  it("fills the form from the saved instance and updates with its revision", async () => {
    const { submitted } = stubStudioApi({
      installed: ["countdown_bar"],
      respond: (path) =>
        path.endsWith("/plugins/countdown-bar/instances/bar-1")
          ? stored
          : undefined,
    });
    editor(`${base}/bar-1`);
    await waitFor(() =>
      expect(screen.getByLabelText("Name")).toHaveValue("Lunch"),
    );
    expect(screen.getByLabelText("Priority")).toHaveValue(3);
    expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Wed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      expectedRevision: 4,
      priority: 3,
      progressFill: "drain",
      contentPadding: 2,
      textScale: 125,
      showConfetti: true,
      daysOfWeek: [1, 3],
      leadTimeSeconds: 900,
    });
  }, 15_000);

  it("reports a newer saved version instead of overwriting it, and reloads on request", async () => {
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const path =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const reply = (status: number, body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status }));
        if (init?.method === "PUT")
          return reply(409, {
            error: {
              code: "plugin_instance_revision_conflict",
              message:
                "Someone else saved a newer version. Reload it, then make your change again.",
              details: { currentRevision: 5 },
            },
          });
        if (path.endsWith("/plugins/countdown-bar/instances/bar-1")) {
          reads += 1;
          return reply(200, {
            data:
              reads === 1
                ? stored
                : { ...stored, name: "Lunch (their edit)", revision: 5 },
          });
        }
        if (path.endsWith("/plugins"))
          return reply(200, {
            data: { items: [], unsupportedInstallations: [] },
          });
        return reply(200, { data: { items: [], total: 0 } });
      }),
    );
    editor(`${base}/bar-1`);
    await waitFor(() =>
      expect(screen.getByLabelText("Name")).toHaveValue("Lunch"),
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Someone else saved a newer version"),
    ).toBeVisible();
    // The person's edit is still on screen: nothing was lost or replaced.
    expect(screen.getByLabelText("Name")).toHaveValue("My edit");
    fireEvent.click(
      screen.getByRole("button", { name: "Reload the latest version" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Name")).toHaveValue("Lunch (their edit)"),
    );
    expect(
      screen.queryByText("Someone else saved a newer version"),
    ).not.toBeInTheDocument();
  }, 15_000);

  it("is read-only for an account that cannot manage plugins", async () => {
    stubStudioApi({
      installed: ["countdown_bar"],
      respond: (path) =>
        path.endsWith("/plugins/countdown-bar/instances/bar-1")
          ? stored
          : undefined,
    });
    editor(`${base}/bar-1`, "viewer");
    await waitFor(() =>
      expect(screen.getByLabelText("Name")).toHaveValue("Lunch"),
    );
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  }, 15_000);
});

describe("hosted instance list for Countdown Bar", () => {
  const list = (role = "owner") =>
    renderPluginRoute(
      <HostedInstancesPage pluginId="countdown_bar" manifest={manifest} />,
      {
        path: base,
        role,
        patterns: [base],
      },
    );

  it("lists instances with their state and priority", async () => {
    stubStudioApi({
      installed: ["countdown_bar"],
      respond: (path) =>
        path.endsWith("/plugins/countdown-bar/instances")
          ? {
              items: [
                stored,
                { ...stored, id: "bar-2", name: "Dismissal", enabled: false },
              ],
              total: 2,
            }
          : undefined,
    });
    list();
    expect(await screen.findByText("Lunch")).toBeVisible();
    expect(screen.getByText("Dismissal")).toBeVisible();
    expect(
      screen.getAllByText("Lunch ends in · priority 3").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: /New countdown bar/ }),
    ).toHaveAttribute("href", `${base}/instances/new`);
  });

  it("explains an empty list, and offers no create to a viewer", async () => {
    stubStudioApi({ installed: ["countdown_bar"] });
    list("viewer");
    expect(await screen.findByText("No countdown bars yet")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /New countdown bar/ }),
    ).not.toBeInTheDocument();
  });

  it("does not show a failed load as an empty list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("{}", { status: 500 }))),
    );
    list();
    expect(await screen.findByText(/could not be loaded/)).toBeVisible();
    expect(screen.queryByText("No countdown bars yet")).not.toBeInTheDocument();
  });
});
