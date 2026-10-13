/**
 * Roles, the capability vocabulary, and content access: who can do what in
 * Studio, and which part of the Media library they reach.
 */
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../transport";
import type {
  CapabilityDefinition,
  ContentAccessInput,
  MyAccess,
  Role,
  RoleInput,
  UserContentAccess,
} from "../types";

export async function listRoles(): Promise<Role[]> {
  const result = await apiGet("/api/v1/roles", {});
  return result.items as Role[];
}

export async function listCapabilities(): Promise<CapabilityDefinition[]> {
  const result = await apiGet("/api/v1/roles/capabilities", {});
  return result.items as CapabilityDefinition[];
}

export function createRole(input: RoleInput, csrfToken: string): Promise<Role> {
  return apiPost("/api/v1/roles", { body: input, csrfToken }) as Promise<Role>;
}

export function updateRole(
  key: string,
  input: RoleInput,
  csrfToken: string,
): Promise<Role> {
  return apiPatch("/api/v1/roles/{key}", {
    params: { path: { key } },
    body: input,
    csrfToken,
  }) as Promise<Role>;
}

export function deleteRole(key: string, csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/roles/{key}", {
    params: { path: { key } },
    csrfToken,
  });
}

export function getUserContentAccess(id: string): Promise<UserContentAccess> {
  return apiGet("/api/v1/users/{id}/content-access", {
    params: { path: { id } },
  }) as Promise<UserContentAccess>;
}

export function putUserContentAccess(
  id: string,
  input: ContentAccessInput,
  csrfToken: string,
): Promise<UserContentAccess> {
  return apiPut("/api/v1/users/{id}/content-access", {
    params: { path: { id } },
    body: input,
    csrfToken,
  }) as Promise<UserContentAccess>;
}

export function getMyAccess(): Promise<MyAccess> {
  return apiGet("/api/v1/me/access", {}) as Promise<MyAccess>;
}
