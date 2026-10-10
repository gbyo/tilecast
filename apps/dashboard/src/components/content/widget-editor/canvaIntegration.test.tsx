// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import {
  mockEditorApi,
  renderEditorRoute,
  savedWidget,
  useViewport,
} from "./testing";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const config = {
  canvaUrl: "https://canva.link/abc123",
  refreshIntervalSeconds: 1800,
};
const compiled = (url: string) =>
  ({
    schemaVersion: 1,
    kind: "web",
    requiredCapabilities: { "web.remote": 2 },
    web: { url },
  }) as never;

it("pastes, previews and saves Canva through the shared editor without claiming remote success", async () => {
  useViewport("tablet");
  mockEditorApi();
  const compile = vi
    .mocked(api.compileWidgetPreview)
    .mockResolvedValue(
      compiled("https://www.canva.com/design/DAGabcdefgh/view?embed="),
    );
  const create = vi
    .spyOn(api, "createWidget")
    .mockResolvedValue(savedWidget("canva", config));
  renderEditorRoute("/widgets/new/canva");
  const input = await screen.findByRole("textbox", {
    name: /Canva design link/,
  });
  fireEvent.change(input, { target: { value: config.canvaUrl } });
  const iframe = await screen.findByTitle(
    "Web Widget preview",
    {},
    { timeout: 3000 },
  );
  expect(compile).toHaveBeenLastCalledWith("canva", config, expect.any(String));
  expect(iframe).toHaveAttribute(
    "src",
    "https://www.canva.com/design/DAGabcdefgh/view?embed=",
  );
  expect(iframe.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  expect(screen.getByRole("link", { name: "Open in Canva" })).toHaveAttribute(
    "href",
    config.canvaUrl,
  );
  fireEvent.load(iframe);
  expect(
    screen.getByText(/URL validated; preview could not be verified/),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Save Widget/ }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0]![0].configuration).toEqual(config);
});

it("clears stale Canva frames while editing and reports errors without retaining a false preview", async () => {
  useViewport("tablet");
  mockEditorApi({ asset: savedWidget("canva", config) });
  const compile = vi
    .mocked(api.compileWidgetPreview)
    .mockResolvedValue(
      compiled("https://www.canva.com/design/DAGabcdefgh/view?embed="),
    );
  renderEditorRoute("/widgets/widget-1");
  await screen.findByTitle("Web Widget preview");
  const input = screen.getByRole("textbox", { name: /Canva design link/ });
  compile.mockRejectedValue(
    new Error("Unsupported Canva URL; publish a public embed."),
  );
  fireEvent.change(input, { target: { value: "https://evil.example/" } });
  expect(screen.queryByTitle("Web Widget preview")).toBeNull();
  expect(screen.queryByRole("link", { name: "Open in Canva" })).toBeNull();
  await waitFor(
    () =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Unsupported Canva URL",
      ),
    { timeout: 3000 },
  );
  expect(screen.getByRole("region", { name: "Preview" })).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  compile.mockResolvedValue(
    compiled("https://www.canva.com/design/DAGijklmnop/view?embed="),
  );
  fireEvent.change(input, {
    target: { value: "https://www.canva.com/design/DAGijklmnop/view" },
  });
  await waitFor(
    () =>
      expect(screen.getByTitle("Web Widget preview")).toHaveAttribute(
        "src",
        "https://www.canva.com/design/DAGijklmnop/view?embed=",
      ),
    { timeout: 3000 },
  );
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.queryByTitle("Web Widget preview")).toBeNull();
});

it("distinguishes an enforced local CSP block from an unverified external load", async () => {
  useViewport("tablet");
  mockEditorApi({ asset: savedWidget("canva", config) });
  vi.mocked(api.compileWidgetPreview).mockResolvedValue(
    compiled("https://www.canva.com/design/DAGabcdefgh/view?embed="),
  );
  renderEditorRoute("/widgets/widget-1");
  await screen.findByTitle("Web Widget preview");
  const violation = (disposition: string) =>
    Object.assign(new Event("securitypolicyviolation", { bubbles: true }), {
      effectiveDirective: "frame-src",
      blockedURI: "https://www.canva.com",
      disposition,
    });
  fireEvent(document, violation("report"));
  expect(screen.getByTitle("Web Widget preview")).toBeVisible();
  fireEvent(document, violation("enforce"));
  expect(screen.queryByTitle("Web Widget preview")).toBeNull();
  expect(
    screen.getByText(/Studio's security policy blocks Canva frames/),
  ).toBeVisible();
  expect(screen.getByRole("link", { name: "Open in Canva" })).toBeVisible();
});
