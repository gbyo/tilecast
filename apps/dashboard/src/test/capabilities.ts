import builtin from "./builtin-capabilities.json";
import { vi } from "vitest";
import type { AuthStatus, MyAccess } from "../api/types";
import { api } from "../api/client";
import * as authModule from "../auth/AuthProvider";

/**
 * Test-only: the capabilities a built-in role carries, copied from the
 * server (apps/server/internal/auth/capabilities.go). A Go test fails if this
 * fixture drifts. Production Studio never derives authority from a role
 * name; it reads AuthStatus.capabilities from the server.
 */
export function builtinCapabilities(role: string | undefined): string[] {
  if (!role || !Object.hasOwn(builtin, role)) return [];
  return [...builtin[role as keyof typeof builtin]];
}

/**
 * Test-only: an authenticated status for `role`, carrying the role's
 * built-in capabilities unless a custom list is given. Models what the
 * server reports without any role-name logic in production code.
 */
export function authStatusFor(
  role: string,
  capabilities?: readonly string[],
): AuthStatus {
  return {
    setupRequired: false,
    authenticated: true,
    csrfToken: "csrf-token",
    user: {
      id: "user",
      name: "Test User",
      username: "test",
      role,
      active: true,
      createdAt: "2026-01-01T00:00:00Z",
    },
    capabilities: [...(capabilities ?? builtinCapabilities(role))],
  };
}

/**
 * Test-only: make `useAuth` report `role` (or an explicit capability list,
 * for a custom role) without rendering the provider.
 */
export function mockAuthAs(role: string, capabilities?: readonly string[]) {
  return vi.spyOn(authModule, "useAuth").mockReturnValue({
    status: authStatusFor(role, capabilities),
    isLoading: false,
    isSubmitting: false,
  } as unknown as ReturnType<typeof authModule.useAuth>);
}

/**
 * Test-only: the access summary the server reports for a built-in role.
 * Every built-in role reaches the whole library and every tag.
 */
export function builtinMyAccess(role: string): MyAccess {
  return {
    role: { key: role, name: role, builtin: true },
    capabilities: builtinCapabilities(role),
    content: { libraryMode: "all", tagMode: "all" },
  };
}

/**
 * Test-only: sign in as a built-in `role` that reaches the whole library, and
 * answer the access summary the Media surfaces read.
 */
export function mockWholeLibrary(role = "editor") {
  mockAuthAs(role);
  return vi.spyOn(api, "myAccess").mockResolvedValue(builtinMyAccess(role));
}
