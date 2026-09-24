import { Button } from "../components/ui/button";

export function SettingsActionBar({
  dirty,
  saving,
  success,
  error,
  onCancel,
  onSave,
  onReload,
}: {
  dirty: boolean;
  saving: boolean;
  success?: string;
  error?: string;
  onCancel: () => void;
  onSave: () => void;
  onReload?: () => void;
}) {
  if (!dirty && !success && !error) return null;
  return (
    <div
      className="sticky bottom-0 z-10 mt-5 flex min-h-[66px] flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 shadow-lg"
      aria-live="polite"
    >
      <div className="grid gap-1">
        {dirty ? (
          <>
            <strong className="text-sm font-semibold">Unsaved changes</strong>
            <span className="text-sm text-muted-foreground">
              Changes are kept while you browse Settings.
            </span>
            {error && <span className="text-sm text-destructive">{error}</span>}
          </>
        ) : success ? (
          <strong className="text-sm font-semibold">{success}</strong>
        ) : (
          <strong className="text-sm text-destructive">{error}</strong>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {error && onReload && (
          <Button type="button" variant="ghost" onClick={onReload}>
            Reload settings
          </Button>
        )}
        {dirty && (
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={saving}
              onClick={onSave}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
