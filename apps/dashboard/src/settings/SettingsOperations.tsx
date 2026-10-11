import { useConfirm } from "../components/ConfirmDialog";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isSettingsExportDocument } from "../api/client";
import { apiErrorMessage } from "../i18n";
import type { MaintenanceAction, SettingsExportDocument } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
export {
  PlayerUpdatesPanel,
  canDeployPlayerUpdates,
  playerUpdateStateLabel,
} from "./player-updates/PlayerUpdatesPanel";

type MaintenanceActionKey =
  | "operations.system.actions.expired-upload-cleanup.label"
  | "operations.system.actions.expired-upload-cleanup.description"
  | "operations.system.actions.completed-command-cleanup.label"
  | "operations.system.actions.completed-command-cleanup.description"
  | "operations.system.actions.retention-cleanup.label"
  | "operations.system.actions.retention-cleanup.description"
  | "operations.system.actions.reconcile-config.label"
  | "operations.system.actions.reconcile-config.description"
  | "operations.system.actions.validate-media.label"
  | "operations.system.actions.validate-media.description";

// Action names hold translation keys, never rendered text. Labels resolve
// with t() at render so the panel follows language changes.
const maintenanceActions: {
  id: MaintenanceAction;
  labelKey: MaintenanceActionKey;
  descriptionKey: MaintenanceActionKey;
  confirm: boolean;
}[] = [
  {
    id: "expired-upload-cleanup",
    labelKey: "operations.system.actions.expired-upload-cleanup.label",
    descriptionKey:
      "operations.system.actions.expired-upload-cleanup.description",
    confirm: true,
  },
  {
    id: "completed-command-cleanup",
    labelKey: "operations.system.actions.completed-command-cleanup.label",
    descriptionKey:
      "operations.system.actions.completed-command-cleanup.description",
    confirm: true,
  },
  {
    id: "retention-cleanup",
    labelKey: "operations.system.actions.retention-cleanup.label",
    descriptionKey: "operations.system.actions.retention-cleanup.description",
    confirm: true,
  },
  {
    id: "reconcile-config",
    labelKey: "operations.system.actions.reconcile-config.label",
    descriptionKey: "operations.system.actions.reconcile-config.description",
    confirm: false,
  },
  {
    id: "validate-media",
    labelKey: "operations.system.actions.validate-media.label",
    descriptionKey: "operations.system.actions.validate-media.description",
    confirm: false,
  },
];
export function SystemPanel({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const auth = useAuth();
  const client = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const query = useQuery({
    queryKey: ["system-status"],
    queryFn: api.systemStatus,
    enabled: canManage,
    refetchInterval: 30_000,
  });
  const maintenance = useMutation({
    mutationFn: (action: MaintenanceAction) =>
      api.runMaintenance(action, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      toast.add({
        title: t("operations.system.completed"),
        type: "success",
      });
      return client.invalidateQueries({ queryKey: ["system-status"] });
    },
  });
  if (!canManage)
    return (
      <Alert role="status">
        <AlertDescription>{t("operations.system.ownerOnly")}</AlertDescription>
      </Alert>
    );
  const s = query.data;
  return (
    <>
      {confirmDialog}
      <div className="grid gap-4">
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("operations.system.diagnosticsTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("operations.system.diagnosticsHint")}
            </p>
          </header>
          {query.error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {t("operations.system.diagnosticsError", {
                  error: apiErrorMessage(query.error),
                })}
              </AlertDescription>
            </Alert>
          ) : !s ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" />
              {t("operations.system.loadingDiagnostics")}
            </p>
          ) : (
            <dl className="my-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Item
                label={t("operations.system.fieldTilecast")}
                value={`${s.tilecastVersion} · ${s.channel} · ${s.buildCommit}`}
              />
              <Item
                label={t("operations.system.fieldUptime")}
                value={formatDuration(s.uptimeSeconds, t)}
              />
              <Item
                label={t("operations.system.fieldDatabase")}
                value={`${s.database.status} · migration ${s.database.migrationVersion}`}
              />
              <Item
                label={t("operations.system.fieldPostgres")}
                value={s.database.postgresVersion}
              />
              <Item
                label={t("operations.system.fieldMediaStorage")}
                value={
                  typeof s.media.status === "string"
                    ? s.media.status
                    : t("operations.system.unknownValue")
                }
              />
              <Item
                label={t("operations.system.fieldConnectedScreens")}
                value={String(s.connectedScreens)}
              />
              <Item
                label={t("operations.system.fieldPendingCommands")}
                value={String(s.pendingCommands)}
              />
              <Item
                label={t("operations.system.fieldProcessingJobs")}
                value={String(s.activeProcessingJobs)}
              />
              <Item
                label={t("operations.system.fieldServerTimezone")}
                value={s.serverTimezone}
              />
            </dl>
          )}
        </section>
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("operations.system.maintenanceTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("operations.system.maintenanceHint")}
            </p>
          </header>
          <div className="grid gap-2">
            {maintenanceActions.map((action) => (
              <div
                key={action.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3"
              >
                <span className="grid gap-0.5">
                  <strong className="text-sm font-semibold">
                    {t(action.labelKey)}
                  </strong>
                  <small className="text-xs text-muted-foreground">
                    {t(action.descriptionKey)}
                  </small>
                </span>
                <Button
                  variant="ghost"

                  disabled={maintenance.isPending}
                  onClick={() => {
                    if (!action.confirm) {
                      maintenance.mutate(action.id);
                      return;
                    }
                    void confirm({
                      title: t("operations.system.runConfirmTitle", {
                        label: t(action.labelKey),
                      }),
                      action: t("operations.system.run"),
                    }).then((ok) => {
                      if (ok) maintenance.mutate(action.id);
                    });
                  }}
                >
                  {maintenance.isPending && maintenance.variables === action.id
                    ? t("operations.system.running")
                    : t("operations.system.run")}
                </Button>
              </div>
            ))}
          </div>
          {maintenance.error && (
            <Alert variant="destructive">
              <AlertDescription>
                {apiErrorMessage(maintenance.error)}
              </AlertDescription>
            </Alert>
          )}
        </section>
      </div>
    </>
  );
}
function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 rounded-xl border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium break-all">{value}</dd>
    </div>
  );
}

export function ImportExportPanel({ owner }: { owner: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const auth = useAuth();
  const { confirm, dialog: confirmDialog } = useConfirm();
  // The selected file, and the preview of exactly that file. Apply imports
  // the previewed document, so replacing or rejecting a file can never leave
  // an older document applicable.
  const [document, setDocument] = useState<SettingsExportDocument>();
  const [preview, setPreview] = useState<{
    document: SettingsExportDocument;
    changedKeys: string[];
    groupPolicyCount: number;
    screenPolicyCount: number;
  } | null>(null);
  const selection = useRef(0);
  const previewMutation = useMutation({
    mutationFn: (candidate: SettingsExportDocument) =>
      api.previewSettingsImport(candidate, auth.status?.csrfToken ?? ""),
    onSuccess: (result, candidate) => {
      // A slower preview of a file the user has since replaced is discarded.
      if (candidate !== document) return;
      setPreview({ ...result, document: candidate });
    },
  });
  const apply = useMutation({
    mutationFn: (candidate: SettingsExportDocument) =>
      api.applySettingsImport(candidate, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      toast.add({
        title: t("operations.importExport.imported"),
        type: "success",
      });
    },
  });
  const selectFile = async (input: HTMLInputElement) => {
    const token = ++selection.current;
    setDocument(undefined);
    setPreview(null);
    previewMutation.reset();
    const file = input.files?.[0];
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      parsed = undefined;
    }
    if (token !== selection.current) return;
    if (!isSettingsExportDocument(parsed)) {
      toast.add({
        title: t("operations.importExport.invalidDocument"),
        type: "error",
      });
      input.value = "";
      return;
    }
    setDocument(parsed);
  };
  if (!owner)
    return (
      <Alert role="status">
        <AlertDescription>
          {t("operations.importExport.ownerOnly")}
        </AlertDescription>
      </Alert>
    );
  return (
    <>
      {confirmDialog}
      <div className="grid gap-4">
        <section className="grid content-start gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("operations.importExport.exportTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("operations.importExport.exportHint")}
            </p>
          </header>
          <div>
            <Button
              variant="default"

              onClick={() => void exportSettings()}
            >
              {t("operations.importExport.exportAction")}
            </Button>
          </div>
        </section>
        <section className="grid content-start gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("operations.importExport.importTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("operations.importExport.importHint")}
            </p>
          </header>
          <Field>
            <FieldLabel htmlFor="settings-import-file">
              {t("operations.importExport.fileLabel")}
            </FieldLabel>
            <Input
              id="settings-import-file"
              type="file"
              accept="application/json"
              onChange={(event) => void selectFile(event.currentTarget)}
            />
          </Field>
          <div>
            <Button
              variant="ghost"

              disabled={!document || previewMutation.isPending}
              onClick={() => document && previewMutation.mutate(document)}
            >
              {previewMutation.isPending
                ? t("operations.importExport.validating")
                : t("operations.importExport.validatePreview")}
            </Button>
          </div>
          {preview && (
            <Alert role="status">
              <AlertDescription className="grid gap-2">
                <strong>
                  {t("operations.importExport.validKeys", {
                    count: preview.changedKeys.length,
                  })}
                </strong>
                <p>
                  {t("operations.importExport.policiesPresent", {
                    group: preview.groupPolicyCount,
                    screen: preview.screenPolicyCount,
                  })}
                </p>
                <div>
                  <Button
                    variant="default"

                    disabled={apply.isPending}
                    onClick={() => {
                      void confirm({
                        title: t("operations.importExport.applyTitle"),
                        action: t("operations.importExport.apply"),
                      }).then((ok) => {
                        if (ok) apply.mutate(preview.document);
                      });
                    }}
                  >
                    {t("operations.importExport.applyAction")}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
        </section>
      </div>
    </>
  );
}
async function exportSettings() {
  const data = await api.exportSettings();
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const link = Object.assign(window.document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `tilecast-settings-${new Date().toISOString().slice(0, 10)}.json`,
  });
  link.click();
  URL.revokeObjectURL(link.href);
}

function formatDuration(seconds: number, t: TFunction<["settings", "common"]>) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return (
    [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`]
      .filter(Boolean)
      .join(" ") || t("operations.system.lessThanMinute")
  );
}
