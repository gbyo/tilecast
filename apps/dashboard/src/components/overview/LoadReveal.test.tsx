// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoadReveal } from "./LoadReveal";

const exitLayer = () => document.querySelector("[data-load-reveal-exit]");
const contentLayer = () => document.querySelector("[data-load-reveal]");

/** jsdom runs no CSS animations; this stands in for a running exit fade. */
function runExitAnimations() {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [{}],
  });
}

function Slot({
  loading,
  variant,
  children = "Resolved",
}: {
  loading: boolean;
  variant?: "standard" | "deliberate";
  children?: React.ReactNode;
}) {
  return (
    <LoadReveal
      loading={loading}
      variant={variant}
      skeleton={<div role="status" aria-label="Loading slot" />}
    >
      {children}
    </LoadReveal>
  );
}

beforeEach(runExitAnimations);

afterEach(() => {
  cleanup();
  delete (Element.prototype as Partial<Element>).getAnimations;
  delete document.documentElement.dataset.reducedMotion;
  vi.unstubAllGlobals();
});

describe("LoadReveal", () => {
  it("shows only the skeleton, with its loading semantics, while loading", () => {
    render(<Slot loading />);
    expect(
      screen.getByRole("status", { name: "Loading slot" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Resolved")).not.toBeInTheDocument();
    expect(exitLayer()).toBeNull();
  });

  it("replaces the skeleton with the content and keeps the old layer out of the accessibility tree", () => {
    const { rerender } = render(<Slot loading />);
    rerender(<Slot loading={false} />);

    expect(screen.getByText("Resolved")).toBeInTheDocument();
    expect(contentLayer()).toHaveAttribute("data-load-reveal", "standard");

    // The outgoing layer is still fading, but it is neither announced nor
    // reachable.
    const layer = exitLayer();
    expect(layer).not.toBeNull();
    expect(layer).toHaveAttribute("aria-hidden", "true");
    expect(layer).toHaveAttribute("inert");
    expect(
      screen.queryByRole("status", { name: "Loading slot" }),
    ).not.toBeInTheDocument();
  });

  it("removes the outgoing layer when its fade ends, and only for its own animation", () => {
    const { rerender } = render(<Slot loading />);
    rerender(<Slot loading={false} />);
    const layer = exitLayer()!;

    fireEvent.animationEnd(layer.firstElementChild!);
    expect(exitLayer()).not.toBeNull();

    fireEvent.animationEnd(layer);
    expect(exitLayer()).toBeNull();
    expect(screen.getByText("Resolved")).toBeInTheDocument();
  });

  it("removes the outgoing layer when its fade is cancelled", () => {
    const { rerender } = render(<Slot loading />);
    rerender(<Slot loading={false} />);

    act(() => {
      exitLayer()!.dispatchEvent(new Event("animationcancel"));
    });
    expect(exitLayer()).toBeNull();
  });

  it("does not leave a layer behind when no fade is running", () => {
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
    const { rerender } = render(<Slot loading />);
    rerender(<Slot loading={false} />);

    expect(exitLayer()).toBeNull();
    expect(screen.getByText("Resolved")).toBeInTheDocument();
  });

  it("uses the deliberate variant when asked", () => {
    const { rerender } = render(<Slot loading variant="deliberate" />);
    rerender(<Slot loading={false} variant="deliberate" />);
    expect(contentLayer()).toHaveAttribute("data-load-reveal", "deliberate");
  });

  it("does not animate content that mounts already resolved", () => {
    render(<Slot loading={false} />);
    expect(screen.getByText("Resolved")).toBeInTheDocument();
    expect(contentLayer()).toBeNull();
    expect(exitLayer()).toBeNull();
  });

  it("does not replay when resolved content changes", () => {
    const { rerender } = render(<Slot loading />);
    rerender(<Slot loading={false}>First</Slot>);
    fireEvent.animationEnd(exitLayer()!);
    const layer = contentLayer();

    rerender(<Slot loading={false}>Second</Slot>);

    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(contentLayer()).toBe(layer);
    expect(exitLayer()).toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("drops the skeleton at once when the resolved slot has nothing to show", () => {
    const { rerender, container } = render(<Slot loading />);
    rerender(<Slot loading={false}>{null}</Slot>);

    expect(exitLayer()).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  describe("reduced motion", () => {
    it("swaps without movement for Tilecast's own preference", () => {
      document.documentElement.dataset.reducedMotion = "true";
      const { rerender } = render(<Slot loading />);
      rerender(<Slot loading={false} />);

      expect(screen.getByText("Resolved")).toBeInTheDocument();
      expect(exitLayer()).toBeNull();
      expect(contentLayer()).toBeNull();
      expect(
        screen.queryByRole("status", { name: "Loading slot" }),
      ).not.toBeInTheDocument();
    });

    it("swaps without movement for the system preference", () => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
          matches: query === "(prefers-reduced-motion: reduce)",
        })),
      );
      const { rerender } = render(<Slot loading variant="deliberate" />);
      rerender(<Slot loading={false} variant="deliberate" />);

      expect(exitLayer()).toBeNull();
      expect(contentLayer()).toBeNull();
    });
  });

  describe("with a query", () => {
    function QueryProbe({ fetcher }: { fetcher: () => Promise<string> }) {
      const query = useQuery({ queryKey: ["probe"], queryFn: fetcher });
      return (
        <LoadReveal
          loading={query.isLoading}
          skeleton={<div role="status" aria-label="Loading probe" />}
        >
          <p>{query.data}</p>
        </LoadReveal>
      );
    }

    it("reveals once and never returns to loading on a background refetch", async () => {
      const client = new QueryClient();
      let resolveRefetch!: (value: string) => void;
      const fetcher = vi
        .fn<() => Promise<string>>()
        .mockResolvedValueOnce("first")
        .mockImplementationOnce(
          () => new Promise((resolve) => (resolveRefetch = resolve)),
        );
      render(
        <QueryClientProvider client={client}>
          <QueryProbe fetcher={fetcher} />
        </QueryClientProvider>,
      );
      expect(screen.getByRole("status")).toBeInTheDocument();
      await screen.findByText("first");
      fireEvent.animationEnd(exitLayer()!);
      const layer = contentLayer();

      act(() => {
        void client.invalidateQueries({ queryKey: ["probe"] });
      });
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

      // The refetch is in flight and the current data is still on screen.
      expect(screen.getByText("first")).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(exitLayer()).toBeNull();
      expect(document.querySelector('[data-state="loading"]')).toBeNull();

      act(() => {
        resolveRefetch("second");
      });
      expect(await screen.findByText("second")).toBeInTheDocument();
      expect(contentLayer()).toBe(layer);
      expect(exitLayer()).toBeNull();
    });
  });
});
