import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { ScreenGroup } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { apiErrorMessage } from "../../i18n";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toast";

/**
 * Create or edit a Display Group. The dialog owns its mutation so a failed
 * save keeps the dialog open with what the person typed.
 */
export function DisplayGroupDialog({
  group,
  open,
  onOpenChange,
  onSaved,
}: {
  /** Omit to create a group. */
  group?: ScreenGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (group: ScreenGroup) => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const client = useQueryClient();
  const editing = Boolean(group);
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");

  const save = useMutation({
    mutationFn: (value: { name: string; description: string }) =>
      group
        ? api.updateScreenGroup(group.id, value, csrf)
        : api.createScreenGroup(value, csrf),
    onSuccess: async (saved) => {
      toast.add({
        title: t(editing ? "groups.updated" : "groups.created"),
        type: "success",
      });
      await client.invalidateQueries({ queryKey: ["screen-groups"] });
      onOpenChange(false);
      onSaved?.(saved);
    },
    onError: () =>
      toast.add({
        title: t(editing ? "groups.errors.update" : "groups.errors.create"),
        type: "error",
      }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim())
              save.mutate({
                name: name.trim(),
                description: description.trim(),
              });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t(
                editing
                  ? "groups.dialog.editTitle"
                  : "groups.dialog.createTitle",
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                editing
                  ? "groups.dialog.editDescription"
                  : "groups.dialog.createDescription",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <Field>
              <FieldLabel htmlFor="group-name">
                {t("groups.dialog.nameLabel")}
              </FieldLabel>
              <Input
                id="group-name"
                value={name}
                autoFocus
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="group-description">
                {t("groups.dialog.descriptionLabel")}
              </FieldLabel>
              <Textarea
                id="group-description"
                value={description}
                maxLength={500}
                rows={3}
                onChange={(event) => setDescription(event.target.value)}
              />
              <FieldDescription>
                {t("groups.dialog.descriptionHint")}
              </FieldDescription>
            </Field>
          </div>
          {save.error && (
            <Alert variant="destructive">
              <AlertDescription>{apiErrorMessage(save.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={save.isPending}
              onClick={() => onOpenChange(false)}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {save.isPending
                ? t("common:actions.saving")
                : t(
                    editing
                      ? "common:actions.saveChanges"
                      : "groups.dialog.createAction",
                  )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
