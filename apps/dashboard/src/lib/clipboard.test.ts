import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";
import { toast } from "../components/ui/toast";

vi.mock("../components/ui/toast", () => ({ toast: { add: vi.fn() } }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const feedback = { success: "Copiado.", failure: "No se pudo copiar." };

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

  it("uses supplied localized feedback on denial without revealing the value or exception", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi
          .fn()
          .mockRejectedValue(new Error("internal browser detail")),
      },
    });
    expect(await copyText("clipboard test", feedback)).toBe(false);
    expect(toast.add).toHaveBeenCalledExactlyOnceWith({
      title: feedback.failure,
      type: "error",
    });
  });

  it("handles a browser or shell without the Clipboard API", async () => {
    vi.stubGlobal("navigator", {});
    expect(await copyText("clipboard test", feedback)).toBe(false);
    expect(toast.add).toHaveBeenCalledExactlyOnceWith({
      title: feedback.failure,
      type: "error",
    });
  });
});
