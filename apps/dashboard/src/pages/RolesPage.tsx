import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Copy, Eye, Lock, Pencil, Plus, Trash2, UserCog } from "lucide-react";
import { api } from "../api/client";
import type { Role } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useCapabilities } from "../auth/capabilities";
import { apiErrorMessage } from "../i18n";
import { useConfirm } from "../components/ConfirmDialog";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";
import {
  RoleEditorDialog,
  type RoleEditorMode,
} from "../settings/access/RoleEditorDialog";
import {
  rolesQueryKey,
  useRoleLabels,
  useRoles,
} from "../settings/access/roleNames";

/**
 * Roles: named bundles of what someone can do. The five built-in roles are
 * fixed so upgrades stay predictable; an installation adds its own beside
 * them (a "Classroom Media" role that only manages a teacher's media, say),
 * and gives each person a role on the Users page.
 */
export function RolesPage() {
  const { t } = useTranslation(["account", "common"]);
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const { can } = useCapabilities();
  const client = useQueryClient();
  const roles = useRoles();
  const catalog = useQuery({
    queryKey: ["role-capabilities"],
    queryFn: api.capabilityCatalog,
  });
  const labels = useRoleLabels(roles.data);
  const [editor, setEditor] = useState<RoleEditorMode>();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const remove = useMutation({
    mutationFn: (role: Role) => api.deleteRole(role.key, csrf),
    onSuccess: async () => {
      toast.add({ title: t("roleAdmin.toasts.deleted"), type: "success" });
      await client.invalidateQueries({ queryKey: rolesQueryKey });
    },
  });
  const canCreate = can("roles.manage");
  const error = roles.error ?? catalog.error;

  return (
    <section className="grid content-start gap-4">
      {confirmDialog}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("roleAdmin.page.intro")}
        </p>
        {canCreate && (
          <Button
            type="button"
            disabled={!catalog.data}
            onClick={() => setEditor({ kind: "create" })}
          >
            <Plus size={16} aria-hidden="true" />{" "}
            {t("roleAdmin.page.createAction")}
          </Button>
        )}
      </div>
      {roles.isLoading || catalog.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" /> {t("roleAdmin.page.loading")}
        </p>
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription role="alert">
            {apiErrorMessage(error)}
          </AlertDescription>
        </Alert>
      ) : (
        <ItemGroup className="gap-2">
          {roles.data?.map((role) => (
            <Item key={role.key} variant="outline">
              <ItemMedia variant="icon">
                {role.builtin ? (
                  <Lock size={16} aria-hidden="true" />
                ) : (
                  <UserCog size={16} aria-hidden="true" />
                )}
              </ItemMedia>
              <ItemContent className="min-w-0 gap-0.5">
                <ItemTitle className="flex flex-wrap items-center gap-2">
                  {labels.name(role.key, role.name)}
                  <Badge variant={role.builtin ? "secondary" : "outline"}>
                    {role.builtin
                      ? t("roleAdmin.page.builtin")
                      : t("roleAdmin.page.custom")}
                  </Badge>
                </ItemTitle>
                <ItemDescription>
                  {labels.description(role.key)}
                </ItemDescription>
                <ItemDescription className="text-xs">
                  {t("roleAdmin.page.people", { count: role.userCount })} ·{" "}
                  {t("roleAdmin.page.capabilityCount", {
                    count: role.capabilities.length,
                  })}
                </ItemDescription>
              </ItemContent>
              <ItemActions className="flex-wrap">
                {role.editable ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditor({ kind: "edit", role })}
                  >
                    <Pencil size={15} aria-hidden="true" />{" "}
                    {t("common:actions.edit")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditor({ kind: "view", role })}
                  >
                    <Eye size={15} aria-hidden="true" />{" "}
                    {t("roleAdmin.page.viewAction")}
                  </Button>
                )}
                {canCreate && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t("roleAdmin.page.duplicateLabel", {
                      name: labels.name(role.key, role.name),
                    })}
                    onClick={() => setEditor({ kind: "create", from: role })}
                  >
                    <Copy size={15} aria-hidden="true" />{" "}
                    {t("roleAdmin.page.duplicateAction")}
                  </Button>
                )}
                {role.editable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={remove.isPending}
                    onClick={() => {
                      void confirm({
                        title: t("roleAdmin.page.deleteTitle", {
                          name: role.name,
                        }),
                        body:
                          role.userCount > 0
                            ? t("roleAdmin.page.deleteInUse", {
                                count: role.userCount,
                              })
                            : t("roleAdmin.page.deleteBody"),
                        action: t("common:actions.delete"),
                        destructive: true,
                      }).then((ok) => {
                        if (ok) remove.mutate(role);
                      });
                    }}
                  >
                    <Trash2 size={15} aria-hidden="true" />{" "}
                    {t("common:actions.delete")}
                  </Button>
                )}
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
      {remove.error && (
        <Alert variant="destructive">
          <AlertDescription role="alert">
            {apiErrorMessage(remove.error)}
          </AlertDescription>
        </Alert>
      )}
      {editor && catalog.data && (
        <RoleEditorDialog
          mode={editor}
          catalog={catalog.data}
          roles={roles.data ?? []}
          csrf={csrf}
          onClose={() => setEditor(undefined)}
          onSaved={async () => {
            await client.invalidateQueries({ queryKey: rolesQueryKey });
            setEditor(undefined);
          }}
        />
      )}
    </section>
  );
}
