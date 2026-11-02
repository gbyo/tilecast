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
  ScreenAccessInput,
  ScreenScopes,
  UserContentAccess,
} from "../types";

export async function listRoles(): Promise<Role[]> {
  const result = await apiGet("/api/v1/roles", {});
  return result.items;
}

export async function listCapabilities(): Promise<CapabilityDefinition[]> {
  const result = await apiGet("/api/v1/roles/capabilities", {});
  return result.items;
}

export function createRole(input: RoleInput, csrfToken: string): Promise<Role> {
  return apiPost("/api/v1/roles", { body: input, csrfToken });
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
  });
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
  });
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
  });
}

export function getMyAccess(): Promise<MyAccess> {
  return apiGet("/api/v1/me/access", {});
}

export function getUserScreenScopes(id: string): Promise<ScreenScopes> {
  return apiGet("/api/v1/users/{id}/screen-scopes", {
    params: { path: { id } },
  });
}

export function putUserScreenScopes(
  id: string,
  input: ScreenAccessInput,
  csrfToken: string,
): Promise<ScreenScopes> {
  return apiPut("/api/v1/users/{id}/screen-scopes", {
    params: { path: { id } },
    body: { mode: input.mode, scopes: input.scopes ?? [] },
    csrfToken,
  });
}
