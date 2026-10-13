import builtin from "./builtin-capabilities.json";

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
