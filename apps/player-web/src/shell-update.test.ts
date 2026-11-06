import { describe, expect, it, vi } from "vitest";
import { ShellUpdate } from "./shell-update";

function container() {
  const target = new EventTarget();
  return {
    target,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    change: () => target.dispatchEvent(new Event("controllerchange")),
  };
}

describe("shell update takeover", () => {
  it("reloads a resting page when another page activates the worker", () => {
    const sw = container();
    const reload = vi.fn();
    new ShellUpdate(sw, () => true, reload).watch();
    sw.change();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("holds a playing page on the takeover and reloads when it rests", () => {
    const sw = container();
    const reload = vi.fn();
    let resting = false;
    const update = new ShellUpdate(sw, () => resting, reload);
    update.watch();
    sw.change();
    expect(reload).not.toHaveBeenCalled();
    update.settle();
    expect(reload).not.toHaveBeenCalled();
    resting = true;
    update.settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when no takeover happened", () => {
    const sw = container();
    const reload = vi.fn();
    const update = new ShellUpdate(sw, () => true, reload);
    update.watch();
    update.settle();
    expect(reload).not.toHaveBeenCalled();
  });

  it("stops listening", () => {
    const sw = container();
    const reload = vi.fn();
    const update = new ShellUpdate(sw, () => true, reload);
    update.watch();
    update.stop();
    sw.change();
    expect(reload).not.toHaveBeenCalled();
  });
});
