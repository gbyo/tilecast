import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, writeTextToClipboard } from "./clipboard";
import { toast } from "../components/ui/toast";

vi.mock("../components/ui/toast", () => ({ toast: { add: vi.fn() } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete (document as Document & { execCommand?: (command: string) => boolean })
    .execCommand;
});

const feedback = { success: "Copiado.", failure: "No se pudo copiar." };

describe("writeTextToClipboard", () => {
  it("uses the Clipboard API when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    expect(await writeTextToClipboard("clipboard test")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("clipboard test");
  });

  it("falls back to execCommand when Clipboard is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    expect(await writeTextToClipboard("clipboard test")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when Clipboard rejects the write", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    });

    expect(await writeTextToClipboard("clipboard test")).toBe(true);
  });
});

describe("copyText", () => {
  it("reports success only after the clipboard write finishes", async () => {
    let finish!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const result = copyText("clipboard test", feedback);
    expect(writeText).toHaveBeenCalledWith("clipboard test");
    expect(toast.add).not.toHaveBeenCalled();
    finish();
    expect(await result).toBe(true);
    expect(toast.add).toHaveBeenCalledExactlyOnceWith({
      title: feedback.success,
      type: "success",
    });
  });

  it("uses supplied localized failure feedback when both copy paths fail", async () => {
    vi.stubGlobal("navigator", {});
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });

    expect(await copyText("clipboard test", feedback)).toBe(false);
    expect(toast.add).toHaveBeenCalledExactlyOnceWith({
      title: feedback.failure,
      type: "error",
    });
  });
});
