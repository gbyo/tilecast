// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { SetupBridge, StatusSurface } from "./status-surface";
import "./status-surface";

function renderSetup(submit: SetupBridge["submit"]) {
  const view = document.createElement(
    "tc-status-surface",
  ) as unknown as StatusSurface;
  view.presentation = { state: "setup" };
  view.servers = [];
  view.setup = { available: true, submit };
  document.body.append(view);
  return view;
}

describe("status-surface manual setup", () => {
  it("labels the address field and submits through a visible button", async () => {
    const submit = vi.fn(async () => ({ ok: true }));
    const view = renderSetup(submit);
    await view.updateComplete;

    const input = view.querySelector<HTMLInputElement>("#setup-input");
    expect(input).not.toBeNull();
    expect(input?.labels?.length ?? 0).toBe(1);
    expect(input?.labels?.[0]?.textContent).toBe("Server address");
    const button = view.querySelector<HTMLButtonElement>(
      '#setup-manual button[type="submit"]',
    );
    expect(button?.textContent).toBe("Connect");

    input!.value = "https://signage.example.org";
    button!.click();
    await view.updateComplete;
    expect(submit).toHaveBeenCalledWith("https://signage.example.org");
    view.remove();
  });

  it("shows the bridge error when the address is rejected", async () => {
    const submit = vi.fn(async () => ({ ok: false, error: "Nope" }));
    const view = renderSetup(submit);
    await view.updateComplete;

    const input = view.querySelector<HTMLInputElement>("#setup-input");
    input!.value = "https://signage.example.org";
    view
      .querySelector<HTMLFormElement>("#setup-manual")!
      .dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
    await view.updateComplete;
    await Promise.resolve();
    await view.updateComplete;
    expect(view.querySelector("#setup-error")?.textContent).toBe("Nope");
    view.remove();
  });
});

describe("status-surface under a presentation provider", () => {
  it("draws nothing while a provider owns the screen, and returns when it does not", async () => {
    const view = document.createElement(
      "tc-status-surface",
    ) as unknown as StatusSurface;
    view.presentation = { state: "external-presentation", provider: "a/b" };
    document.body.append(view);
    await view.updateComplete;
    expect(view.visible).toBe(true);
    expect(view.querySelector("#message")?.classList.contains("visible")).toBe(
      true,
    );

    view.suppressed = true;
    await view.updateComplete;
    expect(view.visible).toBe(false);
    expect(view.querySelector("#message")?.classList.contains("visible")).toBe(
      false,
    );

    // A real problem is never hidden by a provider.
    view.problem = "bridge unavailable";
    await view.updateComplete;
    expect(view.visible).toBe(true);
    view.remove();
  });
});
