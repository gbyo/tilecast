import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { SettingsSection } from "../settings/SettingsSection";
import { SettingsActionBar } from "../settings/SettingsActionBar";
import { useNavigationWarning } from "../settings/useNavigationWarning";

export function PreferencesPage() {
  const auth = useAuth();
  const client = useQueryClient();
  const preferences = useQuery({
    queryKey: ["preferences"],
    queryFn: api.preferences,
  });
  const [baseline, setBaseline] = useState<Record<string, unknown>>();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState<string>();
  useEffect(() => {
    if (preferences.data && !baseline) {
      setBaseline(preferences.data.values);
      setDraft(preferences.data.values);
      setRevision(preferences.data.revision);
    }
  }, [preferences.data, baseline]);
  useEffect(() => applyPreferences(draft), [draft]);
  const definitions = preferences.data?.definitions ?? [];
  const dirty =
    Boolean(baseline) &&
    definitions.some(
      (definition) =>
        !same(
          (baseline ?? {})[definition.key] ?? definition.default,
          draft[definition.key] ?? definition.default,
        ),
    );
  const navigationWarning = useNavigationWarning(
    dirty,
    "/account",
    "Leave My Account with unsaved preference changes?",
  );
  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.updatePreferences(revision, values, auth.status?.csrfToken ?? ""),
    onSuccess: (data) => {
      setBaseline(data.values);
      setDraft(data.values);
      setRevision(data.revision);
      setSaved("Preferences saved.");
      client.setQueryData(["preferences"], data);
    },
  });
  const reload = () => {
    setBaseline(undefined);
    setSaved(undefined);
    void preferences.refetch();
  };
  if (preferences.isLoading)
    return <div className="table-loading">Loading preferences…</div>;
  return (
    <>
      {navigationWarning}
      <SettingsSection
        section="preferences"
        definitions={definitions}
        values={draft}
        editable
        onChange={(key, value) => {
          setSaved(undefined);
          setDraft({ ...draft, [key]: value });
        }}
      />
      <SettingsActionBar
        dirty={dirty}
        saving={save.isPending}
        success={saved}
        error={errorMessage(save.error)}
        onCancel={() => {
          setSaved(undefined);
          if (baseline) setDraft(baseline);
        }}
        onSave={() => {
          setSaved(undefined);
          save.mutate(draft);
        }}
        onReload={isConflict(save.error) ? reload : undefined}
      />
    </>
  );
}

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function isConflict(error: Error | null | undefined) {
  return (
    error instanceof ApiError && error.code === "settings_revision_conflict"
  );
}
function errorMessage(error: Error | null | undefined) {
  if (!error) return undefined;
  return isConflict(error)
    ? "These preferences changed elsewhere. Reload the latest preferences before saving."
    : error.message;
}
function applyPreferences(values: Record<string, unknown>) {
  const root = document.documentElement;
  const appearance =
    typeof values["preference.appearance"] === "string"
      ? String(values["preference.appearance"])
      : "system";
  try {
    window.localStorage.setItem("tilecast.appearance", appearance);
  } catch {
    // Preference state remains available from the server when storage is disabled.
  }
  const dark =
    appearance === "dark" ||
    (appearance === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", dark);
  root.dataset.density =
    typeof values["preference.density"] === "string"
      ? String(values["preference.density"])
      : "comfortable";
  root.dataset.reducedMotion = String(
    Boolean(values["preference.reduced_motion"]),
  );
}
