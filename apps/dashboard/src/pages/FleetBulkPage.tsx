import { useState, type ReactNode } from "react";
import { layoutQueries } from "../data/layouts";

import { playlistQueries } from "../data/playlists";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, History, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { api, ApiError } from "../api/client";
import type {
  BulkAction,
  BulkOperation,
  BulkOperationRequest,
  BulkPreview,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { PageHeader } from "../components/PageHeader";
import { apiErrorMessage, useFormatLocale } from "../i18n";
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
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../components/ui/field";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";

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
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={options}
        value={value}
        onValueChange={(next) => onChange(next ?? "")}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
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
  const auth = useAuth();
  const canManage = ["owner", "administrator"].includes(
    auth.status?.user?.role ?? "",
  );

  if (!canManage) {
    return (
      <div className="grid w-full max-w-[1180px] min-w-0 gap-6">
        <PageHeader title={t("bulk.title")} description={t("bulk.body")} />
        <BulkError>{t("bulk.accessDenied")}</BulkError>
      </div>
    );
  }

  return <FleetBulkWorkspace csrf={auth.status?.csrfToken ?? ""} />;
}

function FleetBulkWorkspace({ csrf }: { csrf: string }) {
  const { t } = useTranslation(["screens", "common"]);
  const formatLocale = useFormatLocale();
  const client = useQueryClient();

  const screens = useQuery({ queryKey: ["screens"], queryFn: api.screens });
  const playlists = useQuery(playlistQueries.list());
  const layouts = useQuery(layoutQueries.list());
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
      toast.add({ title: t("bulk.applied"), type: "success" });
      setResult(data);
      setPreview(undefined);
      void client.invalidateQueries({ queryKey: ["screens"] });
      void client.invalidateQueries({ queryKey: ["bulk-operations"] });
    },
  });
  const undo = useMutation({
    mutationFn: (id: string) => api.undoBulkOperation(id, csrf),
    onSuccess: () => {
      toast.add({ title: t("bulk.undone"), type: "success" });
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
    <div className="grid w-full max-w-[1180px] min-w-0 gap-6">
      <PageHeader title={t("bulk.title")} description={t("bulk.body")} />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <section
          className="grid min-w-0 overflow-hidden rounded-xl border border-border bg-card"
          aria-labelledby="bulk-screens-heading"
        >
          <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h2 id="bulk-screens-heading" className="text-base font-semibold">
                {t("bulk.screensTitle")}
              </h2>
              <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
                {t("bulk.screensBody")}
              </p>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <span className="min-w-[11ch] flex-none text-right text-sm text-muted-foreground tabular-nums">
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
              <div
                className="grid gap-2 p-4"
                role="status"
                aria-label={t("bulk.loading")}
              >
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : screens.isError ? (
              <div className="p-4">
                <Alert variant="destructive">
                  <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                    <span>
                      {t("bulk.screensLoadError")}{" "}
                      {apiErrorMessage(screens.error)}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={screens.isFetching}
                      onClick={() => void screens.refetch()}
                    >
                      {t("common:actions.retry")}
                    </Button>
                  </AlertDescription>
                </Alert>
              </div>
            ) : (
              <Empty className="border-0 py-6">
                <EmptyHeader>
                  <EmptyTitle>{t("bulk.noScreensTitle")}</EmptyTitle>
                  <EmptyDescription>{t("bulk.noScreensHint")}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Link
                    className={buttonVariants({
                      variant: "secondary",
                      size: "sm",
                    })}
                    to="/screens/pair"
                  >
                    {t("page.pairScreen")}
                  </Link>
                </EmptyContent>
              </Empty>
            )
          ) : (
            <div className="grid max-h-[420px] grid-cols-1 content-start gap-1 overflow-y-auto p-2 sm:grid-cols-2">
              {items.map((item) => {
                const isSelected = selected.includes(item.id);
                return (
                  <label
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1 has-checked:border-primary has-checked:bg-accent hover:bg-accent focus-within:outline-2 focus-within:outline-ring focus-within:outline-offset-1"
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
                    <span className="grid min-w-0 gap-px">
                      <span className="truncate text-sm font-medium">
                        {item.name}
                      </span>
                      <small className="truncate text-xs text-muted-foreground">
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
          className="grid min-w-0 overflow-hidden rounded-xl border border-border bg-card lg:sticky lg:top-4"
          aria-labelledby="bulk-change-heading"
        >
          <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h2 id="bulk-change-heading" className="text-base font-semibold">
                {t("bulk.changeTitle")}
              </h2>
            </div>
          </header>

          <div className="grid gap-4 p-4">
            <FieldSet>
              <FieldLegend>{t("bulk.actionLabel")}</FieldLegend>
              <RadioGroup
                value={action}
                onValueChange={(value) => {
                  setAction(value as BulkAction);
                  setPreview(undefined);
                }}
                className="grid gap-2"
              >
                {(Object.keys(actionLabelKeys) as BulkAction[]).map((value) => (
                  <Field
                    key={value}
                    orientation="horizontal"
                    className="items-center gap-3"
                  >
                    <RadioGroupItem value={value} id={`bulk-action-${value}`} />
                    <FieldLabel htmlFor={`bulk-action-${value}`}>
                      {t(actionLabelKeys[value])}
                    </FieldLabel>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>

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

          {build.error && <BulkError>{apiErrorMessage(build.error)}</BulkError>}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/40 px-4 py-3">
            <div className="ml-auto flex flex-wrap items-center gap-2">
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
          applyError={apply.error}
          reviewing={build.isPending}
          onApply={() => apply.mutate()}
          onCancel={() => setPreview(undefined)}
          onReview={() => build.mutate()}
        />
      )}

      {result && (
        <section
          className="grid min-w-0 overflow-hidden rounded-xl border border-border bg-card"
          aria-labelledby="bulk-applied-heading"
        >
          <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h2 id="bulk-applied-heading" className="text-base font-semibold">
                {t("bulk.appliedTitle")}
              </h2>
            </div>
          </header>

          <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border px-4 py-3">
            <div className="flex items-baseline gap-2">
              <strong className="text-lg font-semibold tabular-nums">
                {result.appliedCount}
              </strong>
              <span className="text-sm text-muted-foreground">
                {t("bulk.changed")}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <strong className="text-lg font-semibold tabular-nums">
                {result.skippedCount}
              </strong>
              <span className="text-sm text-muted-foreground">
                {t("bulk.unchanged")}
              </span>
            </div>
            {result.failedCount > 0 && (
              <div className="flex items-baseline gap-2">
                <strong className="text-lg font-semibold tabular-nums">
                  {result.failedCount}
                </strong>
                <span className="text-sm text-muted-foreground">
                  {t("bulk.failed")}
                </span>
              </div>
            )}
          </div>

          {result.failedCount > 0 && (
            <div className="p-4">
              <BulkError>
                {t("bulk.someFailed")}
                <ul className="mt-2 grid list-disc gap-1 pl-5">
                  {result.results
                    .filter((row) => row.error)
                    .map((row) => (
                      <li key={row.screenId}>
                        {row.name}: {row.error}
                      </li>
                    ))}
                </ul>
              </BulkError>
            </div>
          )}

          {undo.error && (
            <div className="px-4 pt-4">
              <BulkError>{apiErrorMessage(undo.error)}</BulkError>
            </div>
          )}

          {result.reversible && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/40 px-4 py-3">
              <p className="max-w-[52ch] text-sm text-muted-foreground">
                {t("bulk.undoWindow", { count: undoWindowMinutes ?? 15 })}
              </p>
              <div className="ml-auto flex flex-wrap items-center gap-2">
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

      <section
        className="grid min-w-0 overflow-hidden rounded-xl border border-border bg-card"
        aria-labelledby="bulk-recent-heading"
      >
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id="bulk-recent-heading" className="text-base font-semibold">
              {t("bulk.recentTitle")}
            </h2>
          </div>
        </header>
        {!operations.data?.length ? (
          <Empty className="border-0 py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{t("bulk.recentEmptyTitle")}</EmptyTitle>
              <EmptyDescription>{t("bulk.recentEmptyHint")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid divide-y divide-border">
            {operations.data.map((operation) => (
              <div
                className="grid grid-cols-1 items-center gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4"
                key={operation.id}
              >
                <div className="grid min-w-0 gap-0.5">
                  <strong className="truncate text-sm font-medium">
                    {t(actionLabelKeys[operation.action])}
                  </strong>
                  <small className="text-xs text-muted-foreground">
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
                  <span className="text-xs text-muted-foreground">
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
  applyError,
  reviewing,
  onApply,
  onCancel,
  onReview,
}: {
  preview: BulkPreview;
  applying: boolean;
  applyError: unknown;
  reviewing: boolean;
  onApply: () => void;
  onCancel: () => void;
  onReview: () => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const stale =
    applyError instanceof ApiError &&
    applyError.code === "bulk_operation_stale";
  return (
    // The preview is the decision point on this page, so it is the one panel
    // that takes the accent outline. Colour is never the only signal: it also
    // carries its own heading and a per-screen verdict in text.
    <section
      className="grid min-w-0 overflow-hidden rounded-xl border border-primary bg-card"
      aria-labelledby="bulk-preview-heading"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 id="bulk-preview-heading" className="text-base font-semibold">
            {t("bulk.previewTitle")}
          </h2>
          <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
            {t("bulk.previewBody")}
          </p>
        </div>
      </header>

      <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <strong className="text-lg font-semibold tabular-nums">
            {preview.changeCount}
          </strong>
          <span className="text-sm text-muted-foreground">
            {t("bulk.willChange")}
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <strong className="text-lg font-semibold tabular-nums">
            {preview.unchangedCount}
          </strong>
          <span className="text-sm text-muted-foreground">
            {t("bulk.alreadyState")}
          </span>
        </div>
        {preview.blockedCount > 0 && (
          <div className="flex items-baseline gap-2">
            <strong className="text-lg font-semibold tabular-nums">
              {preview.blockedCount}
            </strong>
            <span className="text-sm text-muted-foreground">
              {t("bulk.cannotChange")}
            </span>
          </div>
        )}
      </div>

      {preview.warnings.map((warning) => (
        <div className="border-b border-border px-4 py-3" key={warning}>
          <Alert role="status">
            <AlertDescription>{warning}</AlertDescription>
          </Alert>
        </div>
      ))}

      <div className="grid max-h-[380px] divide-y divide-border overflow-y-auto">
        {preview.screens.map((row) => (
          <div
            className="grid grid-cols-1 items-center gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4"
            key={row.screenId}
          >
            <div className="grid min-w-0 gap-0.5">
              <strong className="truncate text-sm font-medium">
                {row.fromGroup
                  ? t("bulk.viaGroup", {
                      name: row.name,
                      group: row.fromGroup,
                    })
                  : row.name}
              </strong>
              {/* The arrow is decoration; "becomes" is what a screen reader
                  needs so the two states are not read as one run-on value. */}
              <small className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                <span>{row.current}</span>
                <ArrowRight
                  size={13}
                  aria-hidden="true"
                  className="flex-none"
                />
                <span className="sr-only">{t("bulk.becomes")}</span>
                <span className="text-foreground">{row.next}</span>
              </small>
            </div>
            <span className="justify-self-start text-xs text-muted-foreground sm:justify-self-end sm:text-right">
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

      {stale ? (
        <div className="border-t border-border p-4">
          <Alert>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{t("bulk.staleBody")}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={reviewing}
                onClick={onReview}
              >
                {t("bulk.reviewAction")}
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : applyError ? (
        <div className="border-t border-border p-4">
          <BulkError>{apiErrorMessage(applyError)}</BulkError>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/40 px-4 py-3">
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="ghost" type="button" onClick={onCancel}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="button"
            disabled={applying || preview.changeCount === 0}
            onClick={onApply}
          >
            {applying
              ? t("bulk.applying")
              : t("bulk.applyAction", { count: preview.changeCount })}
          </Button>
        </div>
      </div>
    </section>
  );
}
