/**
 * `@tilecast/studio/testing` — render a plugin page the way Studio does,
 * with a query client, a router, and a signed-in user, but no server.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { catalogPlugin } from "../plugins/catalogFixtures";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { StudioSessionProvider } from "./session";

export function renderPluginRoute(
  element: ReactNode,
  {
    path,
    patterns = [],
    role = "owner",
  }: {
    /** The URL to open, for example "/plugins/countdown-bar/new". */
    path: string;
    /** Route patterns the element is mounted at, most specific first. */
    patterns?: string[];
    role?: string;
  },
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <StudioSessionProvider
        session={{
          csrfToken: "csrf",
          role,
          canManage: role === "owner" || role === "administrator",
        }}
      >
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            {patterns.map((pattern) => (
              <Route key={pattern} path={pattern} element={element} />
            ))}
            <Route path="*" element={element} />
          </Routes>
        </MemoryRouter>
      </StudioSessionProvider>
    </QueryClientProvider>,
  );
}

/** Base UI Select hides its native control, so pick the way a person does. */
export async function chooseOption(
  selectLabel: string | RegExp,
  optionLabel: string,
) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: selectLabel }));
  await user.click(await screen.findByRole("option", { name: optionLabel }));
}

/**
 * Replace `fetch` with a small fake of the Tilecast API. `respond` answers
 * the plugin's own GET paths (return undefined to fall through); writes are
 * recorded in `submitted` and answered with an empty success. Screens, sync
 * groups, locations, and the plugin catalog get plausible defaults, with the
 * given plugins installed.
 */
export function stubStudioApi({
  respond = () => undefined,
  installed = [],
}: {
  respond?: (path: string) => unknown;
  installed?: string[];
} = {}) {
  const submitted: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const reply = (data: unknown) =>
        Promise.resolve(new Response(JSON.stringify({ data })));
      if (init?.method && init.method !== "GET") {
        submitted.push(
          JSON.parse(
            typeof init.body === "string" ? init.body : "{}",
          ) as Record<string, unknown>,
        );
        return reply({});
      }
      const answer = respond(path);
      if (answer !== undefined) return reply(answer);
      if (path.endsWith("/plugins")) {
        return reply({
          items: installed.map((id) => catalogPlugin({ id })),
          unsupportedInstallations: [],
        });
      }
      if (path.endsWith("/screens")) {
        return reply({
          items: [{ id: "screen-1", name: "Cafeteria" }],
          total: 1,
        });
      }
      if (path.includes("screen-groups")) {
        return reply({ items: [], total: 0, page: 1, pageSize: 100 });
      }
      return reply({ items: [], total: 0 });
    }),
  );
  return { submitted };
}
