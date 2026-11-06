import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, CircleCheck } from "lucide-react";
import { uploadFont } from "../../api/fonts";
import { useAuth } from "../../auth/AuthProvider";
import { Alert, AlertDescription } from "../../components/ui/alert";
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
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Spinner } from "../../components/ui/spinner";
import { apiErrorMessage } from "../../i18n";

type UploadOutcome = {
  name: string;
  ok: boolean;
  message: string;
};

/**
 * Upload TTF or OTF faces. Each file is one request; a face joins the
 * uploaded family whose name its own name table declares.
 */
export function UploadFontDialog({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: () => Promise<void>;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const auth = useAuth();
  const [files, setFiles] = useState<File[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  // The file input is uncontrolled; a new key clears what it displays.
  const [inputKey, setInputKey] = useState(0);
  const [outcomes, setOutcomes] = useState<UploadOutcome[]>([]);
  const upload = async () => {
    setBusy(true);
    const results: UploadOutcome[] = [];
    for (const file of files) {
      try {
        // One at a time: faces of a new family must not race to create it.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const result = await uploadFont(
          file,
          confirmed,
          auth.status?.csrfToken ?? "",
        );
        results.push({
          name: file.name,
          ok: true,
          message: result.embeddingRestricted
            ? t("fonts.uploadDialog.restricted", {
                family: result.family.family,
              })
            : t("fonts.uploadDialog.stored", { family: result.family.family }),
        });
      } catch (error) {
        results.push({
          name: file.name,
          ok: false,
          message: apiErrorMessage(error),
        });
      }
      setOutcomes([...results]);
    }
    setBusy(false);
    setFiles([]);
    setInputKey((key) => key + 1);
    if (results.some((result) => result.ok)) await onUploaded();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("fonts.uploadDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("fonts.uploadDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void upload();
          }}
        >
          <Field>
            <FieldLabel htmlFor="font-upload-files">
              {t("fonts.uploadDialog.filesLabel")}
            </FieldLabel>
            <Input
              key={inputKey}
              id="font-upload-files"
              type="file"
              multiple
              accept=".ttf,.otf,font/ttf,font/otf"
              disabled={busy}
              onChange={(event) =>
                setFiles(Array.from(event.target.files ?? []))
              }
            />
            <FieldDescription>
              {t("fonts.uploadDialog.filesHint")}
            </FieldDescription>
          </Field>
          <Field orientation="horizontal" className="items-start">
            <Checkbox
              id="font-upload-rights"
              checked={confirmed}
              disabled={busy}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />
            <FieldLabel htmlFor="font-upload-rights" className="font-normal">
              {t("fonts.uploadDialog.rights")}
            </FieldLabel>
          </Field>
          {outcomes.length > 0 && (
            <ul className="grid gap-2" aria-live="polite">
              {outcomes.map((outcome, index) => (
                <li key={outcome.name + index}>
                  <Alert variant={outcome.ok ? "default" : "destructive"}>
                    {outcome.ok ? (
                      <CircleCheck aria-hidden="true" />
                    ) : (
                      <CircleAlert aria-hidden="true" />
                    )}
                    <AlertDescription>
                      <span className="font-medium">{outcome.name}</span>
                      {": "}
                      {outcome.message}
                    </AlertDescription>
                  </Alert>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              {t("common:actions.close")}
            </Button>
            <Button
              type="submit"
              disabled={busy || files.length === 0 || !confirmed}
            >
              {busy && <Spinner aria-hidden="true" />}
              {busy
                ? t("fonts.uploadDialog.uploading")
                : t("fonts.uploadDialog.submit", { count: files.length })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
