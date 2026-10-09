// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import QRCode from "qrcode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecurityQr } from "./SecurityQr";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SecurityQr", () => {
  it("does not keep showing a previous URI's code while the new one renders", async () => {
    const next = deferred<string>();
    // The library overloads its callback form; the test only uses the promise form.
    const toDataURL = (uri: string) =>
      uri === "otpauth://first" ? Promise.resolve("data:first") : next.promise;
    vi.spyOn(QRCode, "toDataURL").mockImplementation(toDataURL as never);
    const { rerender, container } = render(
      <SecurityQr uri="otpauth://first" />,
    );
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "data:first",
      ),
    );

    rerender(<SecurityQr uri="otpauth://second" />);
    // The first code belongs to the previous enrollment. It must not stay visible.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".security-qr--pending")).not.toBeNull();

    next.resolve("data:second");
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "data:second",
      ),
    );
  });
});
