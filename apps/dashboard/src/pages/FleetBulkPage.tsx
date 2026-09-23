import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, History, RotateCcw } from "lucide-react";
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

const actionLabels: Record<BulkAction, string> = {
  assign_playlist: "Assign a playlist",
  assign_layout: "Assign a Layout",
  clear_assignment: "Remove the assignment",
  set_enabled: "Enable or disable playback",
  send_command: "Send a command",
};

// The bulk command set is deliberately the safe, idempotent subset. A command
// that takes a screen off the air is a per-screen decision.
const bulkCommands = [
  { value: "sync_now", label: "Sync now" },
  { value: "reload_playback", label: "Reload playback" },
  { value: "clear_media_cache", label: "Clear media cache" },
  { value: "restart_player_process", label: "Restart the Player" },
];

export function FleetBulkPage() {
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
      <PageHeader
        title="Bulk changes"
        description="Apply one change to many screens. Tilecast shows exactly what will change before anything happens, including screens pulled in by a Display Group."
      />

      <div className="bulk-workspace">
        <section className="bulk-panel" aria-labelledby="bulk-screens-heading">
          <header className="bulk-panel__header">
            <div className="bulk-panel__heading">
              <h2 id="bulk-screens-heading">Screens</h2>
              <p>
                A screen in a Display Group shares that group&apos;s assignment,
                so selecting one member includes the rest. The preview lists
                them.
              </p>
            </div>
            <div className="bulk-panel__actions">
              <span className="bulk-count">
                {selected.length} of {items.length} selected
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
                {allSelected ? "Select none" : "Select all"}
              </Button>
            </div>
          </header>

          {items.length === 0 ? (
            screens.isLoading ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                Loading screens…
              </p>
            ) : (
              <Empty className="border-0 py-6">
                <EmptyHeader>
                  <EmptyTitle>No screens are paired yet</EmptyTitle>
                  <EmptyDescription>
                    Pair a player before applying bulk changes.
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
                      Pair screen
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
                      aria-label={`Select ${item.name}`}
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
                          ? `Display Group: ${item.syncGroupName}`
                          : item.location || "No location"}
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
              <h2 id="bulk-change-heading">Change</h2>
            </div>
          </header>

          <div className="bulk-panel__body">
            <BulkSelect
              id="bulk-action"
              label="Action"
              value={action}
              onChange={(value) => {
                setAction(value as BulkAction);
                setPreview(undefined);
              }}
              options={(Object.keys(actionLabels) as BulkAction[]).map(
                (value) => ({ value, label: actionLabels[value] }),
              )}
            />

            {action === "assign_playlist" && (
              <BulkSelect
                id="bulk-playlist"
                label="Playlist"
                value={playlistId}
                onChange={(value) => {
                  setPlaylistId(value);
                  setPreview(undefined);
                }}
                options={(playlists.data?.items ?? []).map((playlist) => ({
                  value: playlist.id,
                  label: playlist.name,
                }))}
                placeholder="Select a playlist"
              />
            )}

            {action === "assign_layout" && (
              <BulkSelect
                id="bulk-layout"
                label="Layout"
                value={layoutId}
                onChange={(value) => {
                  setLayoutId(value);
                  setPreview(undefined);
                }}
                options={(layouts.data?.items ?? []).map((layout) => ({
                  value: layout.id,
                  label: layout.name,
                }))}
                placeholder="Select a Layout"
                hint="Only published Layouts can be assigned."
              />
            )}

            {action === "set_enabled" && (
              <BulkSelect
                id="bulk-enabled"
                label="Playback"
                value={enabled ? "enabled" : "disabled"}
                onChange={(value) => {
                  setEnabled(value === "enabled");
                  setPreview(undefined);
                }}
                options={[
                  { value: "enabled", label: "Enable playback" },
                  { value: "disabled", label: "Disable playback" },
                ]}
              />
            )}

            {action === "send_command" && (
              <BulkSelect
                id="bulk-command"
                label="Command"
                value={commandType}
                onChange={(value) => {
                  setCommandType(value);
                  setPreview(undefined);
                }}
                options={bulkCommands.map((command) => ({
                  value: command.value,
                  label: command.label,
                }))}
                hint="A command cannot be undone once a Player collects it."
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
                {build.isPending ? "Checking…" : "Preview the change"}
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
              <h2 id="bulk-applied-heading">Applied</h2>
            </div>
          </header>

          <div className="bulk-tally">
            <div>
              <strong>{result.appliedCount}</strong>
              <span>changed</span>
            </div>
            <div>
              <strong>{result.skippedCount}</strong>
              <span>unchanged or skipped</span>
            </div>
            {result.failedCount > 0 && (
              <div>
                <strong>{result.failedCount}</strong>
                <span>failed</span>
              </div>
            )}
          </div>

          {result.failedCount > 0 && (
            <BulkError>
              Some screens did not change:
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
              <p>
                You can put this back for the next {undoWindowMinutes ?? 15}{" "}
                minutes.
              </p>
              <div className="bulk-panel__actions">
                <Button
                  variant="secondary"
                  type="button"
                  disabled={undo.isPending}
                  onClick={() => undo.mutate(result.id)}
                >
                  <RotateCcw size={15} aria-hidden="true" />{" "}
                  {undo.isPending ? "Undoing…" : "Undo this change"}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="bulk-panel" aria-labelledby="bulk-recent-heading">
        <header className="bulk-panel__header">
          <div className="bulk-panel__heading">
            <h2 id="bulk-recent-heading">Recent bulk changes</h2>
          </div>
        </header>
        {!operations.data?.length ? (
          <Empty className="border-0 py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No bulk changes yet</EmptyTitle>
              <EmptyDescription>
                Completed fleet changes will appear here with their undo status.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="bulk-history">
            {operations.data.map((operation) => (
              <div className="bulk-history__row" key={operation.id}>
                <div className="bulk-row__copy">
                  <strong>{actionLabels[operation.action]}</strong>
                  <small>
                    {new Date(operation.createdAt).toLocaleString()} ·{" "}
                    {operation.appliedCount} screens
                    {operation.undoneAt ? " · undone" : ""}
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
                    Undo
                  </Button>
                ) : (
                  <span className="bulk-history__note">
                    {operation.undoneAt ? "Undone" : "Undo window closed"}
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
  return (
    <section
      className="bulk-panel bulk-panel--decision"
      aria-labelledby="bulk-preview-heading"
    >
      <header className="bulk-panel__header">
        <div className="bulk-panel__heading">
          <h2 id="bulk-preview-heading">What will change</h2>
          <p>Nothing has been applied yet. Review the rows, then confirm.</p>
        </div>
      </header>

      <div className="bulk-tally">
        <div>
          <strong>{preview.changeCount}</strong>
          <span>will change</span>
        </div>
        <div>
          <strong>{preview.unchangedCount}</strong>
          <span>already in that state</span>
        </div>
        {preview.blockedCount > 0 && (
          <div>
            <strong>{preview.blockedCount}</strong>
            <span>cannot be changed</span>
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
                {row.name}
                {row.fromGroup ? ` (via ${row.fromGroup})` : ""}
              </strong>
              {/* The arrow is decoration; "becomes" is what a screen reader
                  needs so the two states are not read as one run-on value. */}
              <small className="bulk-transition">
                <span>{row.current}</span>
                <ArrowRight size={13} aria-hidden="true" />
                <span className="visually-hidden">becomes</span>
                <span className="bulk-transition__next">{row.next}</span>
              </small>
            </div>
            <span className="bulk-row__verdict">
              {row.blocked ? (
                <Badge variant="secondary">Skipped: {row.blocked}</Badge>
              ) : row.changes ? (
                <Badge>Will change</Badge>
              ) : (
                "No change"
              )}
            </span>
          </div>
        ))}
      </div>

      {error && <BulkError>{error}</BulkError>}

      <div className="bulk-panel__footer">
        <div className="bulk-panel__actions">
          <Button variant="ghost" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={applying || preview.changeCount === 0}
            onClick={onApply}
          >
            {applying
              ? "Applying…"
              : `Change ${preview.changeCount} screen${preview.changeCount === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>
    </section>
  );
}
