import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, Moon, Sun } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { SettingDefinition } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { SettingsSection } from "../settings/SettingsSection";
import { SettingsActionBar } from "../settings/SettingsActionBar";
import { useNavigationWarning } from "../settings/useNavigationWarning";

const APPEARANCE_KEY = "preference.appearance";

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
  const appearance = definitions.find(
    (definition) => definition.key === APPEARANCE_KEY,
  );
  const rest = definitions.filter(
    (definition) => definition.key !== APPEARANCE_KEY,
  );
  const change = (key: string, value: unknown) => {
    setSaved(undefined);
    setDraft({ ...draft, [key]: value });
  };
  const appearanceRaw =
    draft[APPEARANCE_KEY] ?? appearance?.default ?? "system";
  const appearanceValue =
    typeof appearanceRaw === "string" ? appearanceRaw : "system";
  return (
    <>
      {navigationWarning}
      {appearance && (
        <AppearanceControl
          definition={appearance}
          value={appearanceValue}
          onChange={(value) => change(APPEARANCE_KEY, value)}
        />
      )}
      <SettingsSection
        section="preferences"
        definitions={rest}
        values={draft}
        editable
        onChange={change}
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

/**
 * Appearance is a persistent either/or choice, so it gets a single-select
 * Toggle Group rather than the generic registry enum control. It writes
 * through the same draft/save path as every other preference.
 */
function AppearanceControl({
  definition,
  value,
  onChange,
}: {
  definition: SettingDefinition;
  value: string;
  onChange: (value: string) => void;
}) {
  const options =
    Array.isArray(definition.allowed) && definition.allowed.length > 0
      ? definition.allowed
      : ["system", "light", "dark"];
  const icons: Record<string, typeof Sun> = {
    system: Laptop,
    light: Sun,
    dark: Moon,
  };
  const labels: Record<string, string> = {
    system: "System",
    light: "Light",
    dark: "Dark",
  };
  return (
    <section
      className="grid gap-3 rounded-xl border border-border p-4"
      aria-labelledby="appearance-control-title"
    >
      <div className="grid gap-1">
        <h3 id="appearance-control-title" className="text-base font-semibold">
          {definition.title || "Appearance"}
        </h3>
        <p className="text-sm text-muted-foreground">
          Follow this browser, or force Studio light or dark.
        </p>
      </div>
      <ToggleGroup
        aria-label="Appearance"
        value={options.includes(value) ? [value] : []}
        onValueChange={(next) => {
          if (next[0]) onChange(next[0]);
        }}
      >
        {options.map((option) => {
          const Icon = icons[option] ?? Laptop;
          return (
            <ToggleGroupItem
              key={option}
              value={option}
              aria-label={labels[option] ?? option}
            >
              <Icon aria-hidden="true" />
              {labels[option] ?? option}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </section>
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
