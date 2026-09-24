// @vitest-environment jsdom
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "./components/ui/tooltip";

const rendered = vi.hoisted((): { tree: unknown } => ({ tree: undefined }));

vi.mock("react-dom/client", () => ({
  createRoot: () => ({
    render: (tree: unknown) => {
      rendered.tree = tree;
    },
  }),
}));
vi.mock("./i18n", () => ({ initI18n: () => Promise.resolve() }));
vi.mock("./App", () => ({ App: () => null }));

function ancestorsOf(
  node: ReactNode,
  target: unknown,
  path: unknown[] = [],
): unknown[] | undefined {
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === target) return path;
  const children = ([] as ReactNode[]).concat(element.props.children ?? []);
  for (const child of children) {
    const found = ancestorsOf(child, target, [...path, element.type]);
    if (found) return found;
  }
  return undefined;
}

describe("Studio root", () => {
  it("renders every route inside one app-level TooltipProvider", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await import("./main");
    await vi.waitFor(() => expect(rendered.tree).toBeDefined());

    const ancestors = ancestorsOf(rendered.tree as ReactNode, RouterProvider);
    expect(ancestors).toBeDefined();
    expect(ancestors).toContain(TooltipProvider);
  });
});
