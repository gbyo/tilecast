import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, History, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { api } from "../api/client";
import type {
  BulkAction,
  BulkOperation,
  BulkOperationRequest,
  BulkPreview,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { PageHeader } from "../components/PageHeader";
import { useFormatLocale } from "../i18n";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { toast } from "../components/ui/toast";
import { Checkbox } from "../components/ui/checkbox";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import "./FleetBulkPage.css";

function BulkSelect({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div className="bulk-field">
      <label htmlFor={id}>{label}</label>
      <RheaSelect
        items={options}
        value={value}
        onValueChange={(next) => onChange(next ?? "")}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </RheaSelect>
      {hint ? <p>{hint}</p> : null}
    </div>
  );
}

function BulkError({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

const actionLabelKeys = {
  assign_playlist: "bulk.actions.assignPlaylist",
  assign_layout: "bulk.actions.assignLayout",
  clear_assignment: "bulk.actions.clear",
  set_enabled: "bulk.actions.togglePlayback",
  send_command: "bulk.actions.sendCommand",
} as const satisfies Record<BulkAction, string>;

// The bulk command set is deliberately the safe, idempotent subset. A command
// that takes a screen off the air is a per-screen decision.
const bulkCommands = [
  { value: "sync_now", labelKey: "bulk.commands.sync" },
  { value: "reload_playback", labelKey: "bulk.commands.reload" },
  { value: "clear_media_cache", labelKey: "bulk.commands.clearCache" },
  { value: "restart_player_process", labelKey: "bulk.commands.restart" },
] as const;

export function FleetBulkPage() {
  const { t } = useTranslation(["screens", "common"]);
  const formatLocale = useFormatLocale();
  const auth = useAuth();
  const client = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const canManage = ["owner", "administrator"].includes(
    auth.status?.user?.role ?? "",
  );

  const screens = useQuery({ queryKey: ["screens"], queryFn: api.screens });
  const playlists = useQuery({
    queryKey: ["playlists"],
    queryFn: () => api.playlists(),
  });
  const layouts = useQuery({
    queryKey: ["layouts"],
    queryFn: () => api.layouts(),
  });
  const operations = useQuery({
    queryKey: ["bulk-operations"],
    queryFn: () => api.bulkOperations(5),
  });

  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<BulkAction>("assign_playlist");
  const [playlistId, setPlaylistId] = useState("");
  const [layoutId, setLayoutId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [commandType, setCommandType] = useState("sync_now");
  const [preview, setPreview] = useState<BulkPreview>();
  const [result, setResult] = useState<BulkOperation>();
  // Kept separately because apply clears the preview before the result renders.
  const [undoWindowMinutes, setUndoWindowMinutes] = useState<number>();

  const items = screens.data?.items ?? [];

  function buildRequest(): BulkOperationRequest {
    const request: BulkOperationRequest = { screenIds: selected, action };
    if (action === "assign_playlist") request.playlistId = playlistId;
    if (action === "assign_layout") request.layoutId = layoutId;
    if (action === "set_enabled") request.enabled = enabled;
    if (action === "send_command") request.commandType = commandType;
    return request;
  }

  const build = useMutation({
    mutationFn: () => api.previewBulkOperation(buildRequest()),
    onSuccess: (data) => {
      setPreview(data);
      setResult(undefined);
      setUndoWindowMinutes(data.undoWindowMinutes);
    },
  });
  const apply = useMutation({
    mutationFn: () =>
      api.applyBulkOperation(
        { ...buildRequest(), expectedChangeCount: preview?.changeCount ?? 0 },
        csrf,
      ),
    onSuccess: (data) => {
      toast.add({ title: "Bulk changes applied.", type: "success" });
      setResult(data);
      setPreview(undefined);
      void client.invalidateQueries({ queryKey: ["screens"] });
      void client.invalidateQueries({ queryKey: ["bulk-operations"] });
    },
  });
  const undo = useMutation({
    mutationFn: (id: string) => api.undoBulkOperation(id, csrf),
    onSuccess: () => {
      toast.add({ title: "Bulk changes undone.", type: "success" });
      setResult(undefined);
      void client.invalidateQueries({ queryKey: ["screens"] });
      void client.invalidateQueries({ queryKey: ["bulk-operations"] });
    },
  });

  const ready =
    selected.length > 0 &&
    (action !== "assign_playlist" || playlistId !== "") &&
    (action !== "assign_layout" || layoutId !== "");

  const allSelected = items.length > 0 && selected.length === items.length;

  return (
    <div className="bulk-page">
      <PageHeader title={t("bulk.title")} description={t("bulk.body")} />

      <div className="bulk-workspace">
        <section className="bulk-panel" aria-labelledby="bulk-screens-heading">
          <header className="bulk-panel__header">
            <div className="bulk-panel__heading">
              <h2 id="bulk-screens-heading">{t("bulk.screensTitle")}</h2>
              <p>{t("bulk.screensBody")}</p>
            </div>
            <div className="bulk-panel__actions">
              <span className="bulk-count">
                {t("bulk.selectedCount", {
                  selected: selected.length,
                  total: items.length,
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={items.length === 0}
                onClick={() => {
                  setPreview(undefined);
                  setSelected(allSelected ? [] : items.map((item) => item.id));
                }}
              >
                {allSelected ? t("bulk.selectNone") : t("bulk.selectAll")}
              </Button>
            </div>
          </header>

          {items.length === 0 ? (
            screens.isLoading ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                {t("bulk.loading")}
              </p>
            ) : (
              <Empty className="border-0 py-6">
                <EmptyHeader>
                  <EmptyTitle>{t("bulk.noScreensTitle")}</EmptyTitle>
                  <EmptyDescription>
                    {t("bulk.noScreensHint")}
                  </EmptyDescription>
                </EmptyHeader>
                {canManage && (
                  <EmptyContent>
                    <Link
                      className={buttonVariants({
                        variant: "secondary",
                        size: "sm",
                      })}
                      to="/screens/pair"
                    >
                      {t("pairScreen")}
                    </Link>
                  </EmptyContent>
                )}
              </Empty>
            )
          ) : (
            <div className="bulk-picker">
              {items.map((item) => {
                const isSelected = selected.includes(item.id);
                return (
                  <label
                    className={`bulk-picker__option${
                      isSelected ? " bulk-picker__option--selected" : ""
                    }`}
                    key={item.id}
                  >
                    <Checkbox
                      checked={isSelected}
                      aria-label={t("bulk.selectAria", { name: item.name })}
                      onCheckedChange={(checked) => {
                        setPreview(undefined);
                        setSelected((ids) =>
                          checked === true
                            ? [...ids, item.id]
                            : ids.filter((id) => id !== item.id),
                        );
                      }}
                    />
                    <span className="bulk-picker__label">
                      <span>{item.name}</span>
                      <small>
                        {item.syncGroupName
                          ? t("bulk.groupAttribution", {
                              name: item.syncGroupName,
                            })
                          : item.location || t("bulk.noLocation")}
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </section>

        <section
          className="bulk-panel bulk-change"
          aria-labelledby="bulk-change-heading"
        >
          <header className="bulk-panel__header">
            <div className="bulk-panel__heading">
              <h2 id="bulk-change-heading">{t("bulk.changeTitle")}</h2>
            </div>
          </header>

          <div className="bulk-panel__body">
            <BulkSelect
              id="bulk-action"
              label={t("bulk.actionLabel")}
              value={action}
              onChange={(value) => {
                setAction(value as BulkAction);
                setPreview(undefined);
              }}
              options={(Object.keys(actionLabelKeys) as BulkAction[]).map(
                (value) => ({ value, label: t(actionLabelKeys[value]) }),
              )}
            />

            {action === "assign_playlist" && (
              <BulkSelect
                id="bulk-playlist"
                label={t("bulk.playlistLabel")}
                value={playlistId}
                onChange={(value) => {
                  setPlaylistId(value);
                  setPreview(undefined);
                }}
                options={(playlists.data?.items ?? []).map((playlist) => ({
                  value: playlist.id,
                  label: playlist.name,
                }))}
                placeholder={t("bulk.pickPlaylist")}
              />
            )}

            {action === "assign_layout" && (
              <BulkSelect
                id="bulk-layout"
                label={t("bulk.layoutLabel")}
                value={layoutId}
                onChange={(value) => {
                  setLayoutId(value);
                  setPreview(undefined);
                }}
                options={(layouts.data?.items ?? []).map((layout) => ({
                  value: layout.id,
                  label: layout.name,
                }))}
                placeholder={t("bulk.pickLayout")}
                hint={t("bulk.layoutHint")}
              />
            )}

            {action === "set_enabled" && (
              <BulkSelect
                id="bulk-enabled"
                label={t("bulk.playbackLabel")}
                value={enabled ? "enabled" : "disabled"}
                onChange={(value) => {
                  setEnabled(value === "enabled");
                  setPreview(undefined);
                }}
                options={[
                  { value: "enabled", label: t("detail.enablePlayback") },
                  { value: "disabled", label: t("detail.disableAction") },
                ]}
              />
            )}

            {action === "send_command" && (
              <BulkSelect
                id="bulk-command"
                label={t("bulk.commandLabel")}
                value={commandType}
                onChange={(value) => {
                  setCommandType(value);
                  setPreview(undefined);
                }}
                options={bulkCommands.map((command) => ({
                  value: command.value,
                  label: t(command.labelKey),
                }))}
                hint={t("bulk.commandHint")}
              />
            )}
          </div>

          {build.error && <BulkError>{build.error.message}</BulkError>}

          <div className="bulk-panel__footer">
            <div className="bulk-panel__actions">
              <Button
                type="button"
                disabled={!ready || build.isPending}
                onClick={() => build.mutate()}
              >
                {build.isPending ? t("bulk.checking") : t("bulk.preview")}
              </Button>
            </div>
          </div>
        </section>
      </div>

      {preview && (
        <PreviewSection
          preview={preview}
          applying={apply.isPending}
          error={apply.error?.message}
          onApply={() => apply.mutate()}
          onCancel={() => setPreview(undefined)}
        />
      )}

      {result && (
        <section className="bulk-panel" aria-labelledby="bulk-applied-heading">
          <header className="bulk-panel__header">
            <div className="bulk-panel__heading">
              <h2 id="bulk-applied-heading">{t("bulk.appliedTitle")}</h2>
            </div>
          </header>

          <div className="bulk-tally">
            <div>
              <strong>{result.appliedCount}</strong>
              <span>{t("bulk.changed")}</span>
            </div>
            <div>
              <strong>{result.skippedCount}</strong>
              <span>{t("bulk.unchanged")}</span>
            </div>
            {result.failedCount > 0 && (
              <div>
                <strong>{result.failedCount}</strong>
                <span>{t("bulk.failed")}</span>
              </div>
            )}
          </div>

          {result.failedCount > 0 && (
            <BulkError>
              {t("bulk.someFailed")}
              <ul>
                {result.results
                  .filter((row) => row.error)
                  .map((row) => (
                    <li key={row.screenId}>
                      {row.name}: {row.error}
                    </li>
                  ))}
              </ul>
            </BulkError>
          )}

          {undo.error && <BulkError>{undo.error.message}</BulkError>}

          {result.reversible && (
            <div className="bulk-panel__footer">
              <p>{t("bulk.undoWindow", { count: undoWindowMinutes ?? 15 })}</p>
              <div className="bulk-panel__actions">
                <Button
                  variant="secondary"
                  type="button"
                  disabled={undo.isPending}
                  onClick={() => undo.mutate(result.id)}
                >
                  <RotateCcw size={15} aria-hidden="true" />{" "}
                  {undo.isPending ? t("bulk.undoing") : t("bulk.undoAction")}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="bulk-panel" aria-labelledby="bulk-recent-heading">
        <header className="bulk-panel__header">
          <div className="bulk-panel__heading">
            <h2 id="bulk-recent-heading">{t("bulk.recentTitle")}</h2>
          </div>
        </header>
        {!operations.data?.length ? (
          <Empty className="border-0 py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{t("bulk.recentEmptyTitle")}</EmptyTitle>
              <EmptyDescription>
                {t("bulk.recentEmptyHint")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="bulk-history">
            {operations.data.map((operation) => (
              <div className="bulk-history__row" key={operation.id}>
                <div className="bulk-row__copy">
                  <strong>{t(actionLabelKeys[operation.action])}</strong>
                  <small>
                    {new Date(operation.createdAt).toLocaleString(formatLocale)}{" "}
                    ·{" "}
                    {t("bulk.historyScreens", {
                      count: operation.appliedCount,
                    })}
                    {operation.undoneAt ? t("bulk.historyUndone") : ""}
                  </small>
                </div>
                {operation.reversible ? (
                  // Undo is consequential, so it keeps a visible outline rather
                  // than the quiet variant that reads as plain text at rest.
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    disabled={undo.isPending}
                    onClick={() => undo.mutate(operation.id)}
                  >
                    {t("bulk.undo")}
                  </Button>
                ) : (
                  <span className="bulk-history__note">
                    {operation.undoneAt
                      ? t("bulk.statusUndone")
                      : t("bulk.windowClosed")}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function PreviewSection({
  preview,
  applying,
  error,
  onApply,
  onCancel,
}: {
  preview: BulkPreview;
  applying: boolean;
  error?: string;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  return (
    <section
      className="bulk-panel bulk-panel--decision"
      aria-labelledby="bulk-preview-heading"
    >
      <header className="bulk-panel__header">
        <div className="bulk-panel__heading">
          <h2 id="bulk-preview-heading">{t("bulk.previewTitle")}</h2>
          <p>{t("bulk.previewBody")}</p>
        </div>
      </header>

      <div className="bulk-tally">
        <div>
          <strong>{preview.changeCount}</strong>
          <span>{t("bulk.willChange")}</span>
        </div>
        <div>
          <strong>{preview.unchangedCount}</strong>
          <span>{t("bulk.alreadyState")}</span>
        </div>
        {preview.blockedCount > 0 && (
          <div>
            <strong>{preview.blockedCount}</strong>
            <span>{t("bulk.cannotChange")}</span>
          </div>
        )}
      </div>

      {preview.warnings.map((warning) => (
        <Alert key={warning} role="status">
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ))}

      <div className="bulk-rows">
        {preview.screens.map((row) => (
          <div className="bulk-row" key={row.screenId}>
            <div className="bulk-row__copy">
              <strong>
                {row.fromGroup
                  ? t("bulk.viaGroup", {
                      name: row.name,
                      group: row.fromGroup,
                    })
                  : row.name}
              </strong>
              {/* The arrow is decoration; "becomes" is what a screen reader
                  needs so the two states are not read as one run-on value. */}
              <small className="bulk-transition">
                <span>{row.current}</span>
                <ArrowRight size={13} aria-hidden="true" />
                <span className="visually-hidden">{t("bulk.becomes")}</span>
                <span className="bulk-transition__next">{row.next}</span>
              </small>
            </div>
            <span className="bulk-row__verdict">
              {row.blocked ? (
                <Badge variant="secondary">
                  {t("bulk.skippedReason", { reason: row.blocked })}
                </Badge>
              ) : row.changes ? (
                <Badge>{t("bulk.willChangeBadge")}</Badge>
              ) : (
                t("bulk.noChange")
              )}
            </span>
          </div>
        ))}
      </div>

      {error && <BulkError>{error}</BulkError>}

      <div className="bulk-panel__footer">
        <div className="bulk-panel__actions">
          <Button variant="ghost" type="button" onClick={onCancel}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="button"
            disabled={applying || preview.changeCount === 0}
            onClick={onApply}
          >
            {applying
              ? t("groups.detail.applying")
              : t("bulk.applyAction", { count: preview.changeCount })}
          </Button>
        </div>
      </div>
    </section>
  );
}
