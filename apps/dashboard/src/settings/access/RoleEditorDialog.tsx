import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Lock, Save } from "lucide-react";
import { api } from "../../api/client";
import type { CapabilityDefinition, Role } from "../../api/types";
import { apiErrorMessage } from "../../i18n";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toast";
import { useRoleLabels } from "./roleNames";
import {
  canSelect,
  capabilityMessageKey,
  grantableSubset,
  groupCatalog,
  toggleCapability,
} from "./capabilitySelection";

export type RoleEditorMode =
  | { kind: "create"; from?: Role }
  | { kind: "edit"; role: Role }
  | { kind: "view"; role: Role };

/**
 * Creates, edits, or shows a role. Capabilities are grouped by Studio area
 * and read as plain sentences, so an operator chooses what someone can do
 * rather than which endpoints they can call. A capability the signed-in
 * account cannot grant is shown, disabled, with the reason.
 */
export function RoleEditorDialog({
  mode,
  catalog,
  roles,
  csrf,
  onClose,
  onSaved,
}: {
  mode: RoleEditorMode;
  catalog: readonly CapabilityDefinition[];
  roles: readonly Role[];
  csrf: string;
  onClose: () => void;
  onSaved: (role: Role) => Promise<void> | void;
}) {
  const { t } = useTranslation(["account", "common"]);
  // Capability and group labels are keyed by the server's vocabulary, which
  // the typed key list cannot enumerate from a value.
  const translate = t as unknown as (
    key: string,
    options?: Record<string, unknown>,
  ) => string;
  const labels = useRoleLabels(roles);
  const source = mode.kind === "create" ? mode.from : mode.role;
  const readOnly = mode.kind === "view";
  const [name, setName] = useState(() =>
    mode.kind === "create"
      ? source
        ? t("roleAdmin.editor.copyName", {
            name: labels.name(source.key, source.name),
          })
        : ""
      : labels.name(mode.role.key, mode.role.name),
  );
  const [description, setDescription] = useState(() =>
    mode.kind === "edit" ? mode.role.description : "",
  );
  const [selected, setSelected] = useState<Set<string>>(() =>
    mode.kind === "view"
      ? new Set(mode.role.capabilities)
      : grantableSubset(catalog, source?.capabilities ?? []),
  );
  const groups = useMemo(() => groupCatalog(catalog), [catalog]);
  const save = useMutation({
    mutationFn: () => {
      const input = {
        name: name.trim(),
        description: description.trim(),
        capabilities: [...selected].sort(),
      };
      return mode.kind === "edit"
        ? api.updateRole(mode.role.key, input, csrf)
        : api.createRole(input, csrf);
    },
    onSuccess: async (role) => {
      toast.add({
        title:
          mode.kind === "edit"
            ? t("roleAdmin.toasts.updated")
            : t("roleAdmin.toasts.created"),
        type: "success",
      });
      await onSaved(role);
    },
  });
  const title =
    mode.kind === "create"
      ? t("roleAdmin.editor.createTitle")
      : mode.kind === "edit"
        ? t("roleAdmin.editor.editTitle", {
            name: labels.name(mode.role.key, mode.role.name),
          })
        : labels.name(mode.role.key, mode.role.name);
  const reason = (definition: CapabilityDefinition) => {
    if (definition.ownerReserved) return t("roleAdmin.editor.ownerReserved");
    if (!definition.delegable) return t("roleAdmin.editor.ownerOnly");
    return t("roleAdmin.editor.notYours");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {readOnly && mode.role.builtin
              ? t("roleAdmin.editor.builtinDescription")
              : t("roleAdmin.editor.description")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!readOnly) save.mutate();
          }}
        >
          {!readOnly && (
            <div className="grid gap-4">
              <Field>
                <FieldLabel htmlFor="role-editor-name">
                  {t("roleAdmin.editor.nameLabel")}
                </FieldLabel>
                <Input
                  id="role-editor-name"
                  value={name}
                  maxLength={60}
                  placeholder={t("roleAdmin.editor.namePlaceholder")}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="role-editor-description">
                  {t("roleAdmin.editor.descriptionLabel")}
                </FieldLabel>
                <Textarea
                  id="role-editor-description"
                  value={description}
                  maxLength={280}
                  rows={2}
                  placeholder={t("roleAdmin.editor.descriptionPlaceholder")}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
            </div>
          )}
          <div className="grid gap-1">
            <h3 className="text-sm font-semibold">
              {t("roleAdmin.editor.capabilitiesTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {readOnly
                ? t("roleAdmin.editor.capabilitiesViewHint")
                : t("roleAdmin.editor.capabilitiesHint")}
            </p>
          </div>
          {groups.map(({ group, items }) => {
            const chosen = items.filter((item) =>
              selected.has(item.key),
            ).length;
            if (readOnly && chosen === 0) return null;
            return (
              <FieldSet
                key={group}
                className="gap-2 border-t border-border pt-4"
              >
                <FieldLegend className="flex w-full items-center justify-between gap-2">
                  <span>{translate(`roleAdmin.groups.${group}`)}</span>
                  <Badge variant="secondary">
                    {t("roleAdmin.editor.groupCount", {
                      count: chosen,
                      total: items.length,
                    })}
                  </Badge>
                </FieldLegend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {items
                    .filter((item) => !readOnly || selected.has(item.key))
                    .map((item) => {
                      const id = `role-capability-${capabilityMessageKey(item.key)}`;
                      const selectable =
                        readOnly || canSelect(catalog, item.key);
                      const checked = selected.has(item.key);
                      const locked = !readOnly && !selectable && !checked;
                      return (
                        <Field
                          key={item.key}
                          orientation="horizontal"
                          className="items-start gap-3"
                          data-disabled={readOnly || locked}
                        >
                          <Checkbox
                            id={id}
                            checked={checked}
                            disabled={readOnly || locked}
                            onCheckedChange={(next) =>
                              setSelected(
                                toggleCapability(
                                  catalog,
                                  selected,
                                  item.key,
                                  next === true,
                                ),
                              )
                            }
                          />
                          <div className="grid gap-0.5">
                            <FieldLabel htmlFor={id}>
                              {translate(
                                `roleAdmin.capabilities.${capabilityMessageKey(item.key)}.label`,
                                { defaultValue: item.key },
                              )}
                              {locked && <Lock size={12} aria-hidden="true" />}
                            </FieldLabel>
                            <FieldDescription className="text-xs">
                              {locked
                                ? reason(item)
                                : translate(
                                    `roleAdmin.capabilities.${capabilityMessageKey(item.key)}.description`,
                                    { defaultValue: "" },
                                  )}
                            </FieldDescription>
                          </div>
                        </Field>
                      );
                    })}
                </div>
              </FieldSet>
            );
          })}
          {save.error && (
            <Alert variant="destructive">
              <AlertDescription role="alert">
                {apiErrorMessage(save.error)}
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {readOnly
                ? t("common:actions.close")
                : t("common:actions.cancel")}
            </Button>
            {!readOnly && (
              <Button
                type="submit"
                disabled={
                  save.isPending ||
                  name.trim().length < 2 ||
                  selected.size === 0
                }
              >
                <Save size={15} aria-hidden="true" />{" "}
                {save.isPending
                  ? t("common:actions.saving")
                  : mode.kind === "edit"
                    ? t("common:actions.saveChanges")
                    : t("roleAdmin.editor.createAction")}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
