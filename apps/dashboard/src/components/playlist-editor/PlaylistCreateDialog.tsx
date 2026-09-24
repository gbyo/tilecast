import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button as RheaButton } from "../../components/ui/button";
import {
  Dialog as RheaDialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Field, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { toast } from "../../components/ui/toast";

// PlaylistCreateDialog is the single creation dialog shared by the Playlists
// page and the playlist library: name the playlist and choose how its items
// are selected. Both surfaces previously carried their own copy.
export function PlaylistCreateDialog({
  open,
  csrf,
  onClose,
  onCreated,
}: {
  open: boolean;
  csrf: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation(["playlists", "common"]);
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<"static" | "tag">("static");
  const create = useMutation({
    mutationFn: () =>
      api.createPlaylist({ name, description: "", sourceType }, csrf),
    onSuccess: (playlist) => {
      toast.add({ title: "Playlist created.", type: "success" });
      onCreated(playlist.id);
    },
  });
  return (
    <RheaDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("create.title")}</DialogTitle>
          <DialogDescription>{t("create.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field>
            <FieldLabel htmlFor="playlist-create-name">
              {t("create.nameLabel")}
            </FieldLabel>
            <Input
              id="playlist-create-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">
              {t("create.typeLabel")}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <RheaButton
                type="button"
                variant={sourceType === "static" ? "default" : "outline"}
                className="h-auto flex-col items-start gap-1 p-3 text-left"
                aria-pressed={sourceType === "static"}
                onClick={() => setSourceType("static")}
              >
                <strong className="text-sm">{t("create.standardTitle")}</strong>
                <span className="text-xs font-normal opacity-80">
                  {t("create.standardDescription")}
                </span>
              </RheaButton>
              <RheaButton
                type="button"
                variant={sourceType === "tag" ? "default" : "outline"}
                className="h-auto flex-col items-start gap-1 p-3 text-left"
                aria-pressed={sourceType === "tag"}
                onClick={() => setSourceType("tag")}
              >
                <strong className="text-sm">{t("create.tagTitle")}</strong>
                <span className="text-xs font-normal opacity-80">
                  {t("create.tagDescription")}
                </span>
              </RheaButton>
            </div>
          </fieldset>
          {create.error && (
            <Alert variant="destructive">
              <AlertDescription>{create.error.message}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <RheaButton type="button" variant="outline" onClick={onClose}>
            {t("common:actions.cancel")}
          </RheaButton>
          <RheaButton
            type="button"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? t("create.creating") : t("create.submit")}
          </RheaButton>
        </DialogFooter>
      </DialogContent>
    </RheaDialog>
  );
}
