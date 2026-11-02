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

describe("status-surface phone setup", () => {
  function renderPhone(
    phoneSetup: Extract<
      StatusSurface["presentation"],
      { state: "setup" }
    >["phoneSetup"],
    resumePhoneSetup?: () => void,
  ) {
    const view = document.createElement(
      "tc-status-surface",
    ) as unknown as StatusSurface;
    view.presentation = { state: "setup", phoneSetup };
    view.servers = [];
    view.setup = {
      available: true,
      submit: async () => ({ ok: true }),
      resumePhoneSetup,
    };
    document.body.append(view);
    return view;
  }

  it("shows the setup QR code beside manual entry", async () => {
    const view = renderPhone({
      state: "ready",
      url: "https://setup.tilecast.org/#v=1&r=AAAAAAAAAAAAAAAAAAAAAA&k=B",
    });
    await view.updateComplete;
    const qr = view.querySelector<HTMLImageElement>(".phone-setup__qr");
    expect(qr?.src).toMatch(/^data:image\/svg\+xml/);
    expect(view.querySelector(".phone-setup h2")?.textContent).toBe(
      "Set up with your phone",
    );
    expect(view.querySelector(".phone-setup__notice")).toBeNull();
    expect(view.querySelector("#setup-input")).not.toBeNull();
    view.remove();
  });

  it("explains a rejected address", async () => {
    const view = renderPhone({
      state: "ready",
      url: "https://setup.tilecast.org/#v=1",
      rejected: true,
    });
    await view.updateComplete;
    expect(view.querySelector(".phone-setup__notice")?.textContent).toContain(
      "could not be used",
    );
    view.remove();
  });

  it("offers a button that resumes a paused session", async () => {
    const resume = vi.fn();
    const view = renderPhone({ state: "paused" }, resume);
    await view.updateComplete;
    expect(view.querySelector(".phone-setup__qr")).toBeNull();
    view.querySelector<HTMLButtonElement>("#phone-setup-resume")!.click();
    expect(resume).toHaveBeenCalledOnce();
    view.remove();
  });

  it("shows nothing for phone setup when the relay is unavailable or the host cannot resume", async () => {
    for (const [state, resume] of [
      [{ state: "unavailable" }, vi.fn()],
      [{ state: "paused" }, undefined],
    ] as const) {
      const view = renderPhone(state, resume);
      await view.updateComplete;
      expect(view.querySelector(".phone-setup")).toBeNull();
      expect(view.querySelector("#setup-input")).not.toBeNull();
      view.remove();
    }
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

describe("status-surface branded states", () => {
  it("shows the title and subtitle but never the machine reason code", async () => {
    const view = document.createElement(
      "tc-status-surface",
    ) as unknown as StatusSurface;
    view.presentation = {
      state: "idle",
      title: "No content assigned",
      message: "This screen is ready for content.",
      status: "no_content",
    };
    document.body.append(view);
    await view.updateComplete;

    const fallback = view.querySelector(".branded-fallback");
    expect(fallback?.querySelector("h1")?.textContent).toBe(
      "No content assigned",
    );
    expect(fallback?.querySelector("p")?.textContent).toBe(
      "This screen is ready for content.",
    );
    expect(fallback?.querySelectorAll("p")).toHaveLength(1);
    expect(view.textContent).not.toMatch(/no[ _]content$/i);
    expect(fallback?.getAttribute("data-status")).toBe("no_content");
    view.remove();
  });

  it("draws no empty subtitle when the message is blank", async () => {
    const view = document.createElement(
      "tc-status-surface",
    ) as unknown as StatusSurface;
    view.presentation = {
      state: "disabled",
      title: "Screen disabled",
      message: "",
      status: "disabled",
    };
    document.body.append(view);
    await view.updateComplete;
    expect(view.querySelectorAll(".branded-fallback p")).toHaveLength(0);
    view.remove();
  });
});
