import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { BuiltinRole, Role } from "../../api/types";

export const rolesQueryKey = ["roles"] as const;

const builtinRoleKeys = {
  owner: "roles.owner",
  administrator: "roles.administrator",
  editor: "roles.editor",
  contributor: "roles.contributor",
  viewer: "roles.viewer",
} as const satisfies Record<BuiltinRole, string>;

const builtinDescriptionKeys = {
  owner: "roles.descriptions.owner",
  administrator: "roles.descriptions.administrator",
  editor: "roles.descriptions.editor",
  contributor: "roles.descriptions.contributor",
  viewer: "roles.descriptions.viewer",
} as const satisfies Record<BuiltinRole, string>;

export function isBuiltinRole(key: string): key is BuiltinRole {
  return Object.hasOwn(builtinRoleKeys, key);
}

/** The roles query shared by the Users and Roles pages. */
export function useRoles(enabled = true) {
  return useQuery({ queryKey: rolesQueryKey, queryFn: api.roles, enabled });
}

/**
 * Names roles for display. Built-in roles are translated; a custom role shows
 * the name its administrator gave it.
 */
export function useRoleLabels(roles?: readonly Role[]) {
  const { t } = useTranslation("account");
  const name = (key: string, fallback?: string) => {
    if (isBuiltinRole(key)) return t(builtinRoleKeys[key]);
    return roles?.find((role) => role.key === key)?.name ?? fallback ?? key;
  };
  const description = (key: string) => {
    if (isBuiltinRole(key)) return t(builtinDescriptionKeys[key]);
    return roles?.find((role) => role.key === key)?.description ?? "";
  };
  return { name, description };
}

/**
 * The signed-in account's own role name. A built-in role is translated; a
 * custom role's name comes from the account's own access summary, which
 * every account may read.
 */
export function useMyRoleName(role: string | undefined) {
  const { t } = useTranslation("account");
  const builtin = role !== undefined && isBuiltinRole(role);
  const access = useQuery({
    queryKey: ["my-access"],
    queryFn: api.myAccess,
    enabled: role !== undefined && !builtin,
  });
  if (role === undefined) return "";
  if (builtin) return t(builtinRoleKeys[role]);
  return access.data?.role.name ?? "";
}
