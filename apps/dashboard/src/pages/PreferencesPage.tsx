import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import type { SettingDefinition } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import {
  LANGUAGE_PREFERENCE_KEY,
  NATIVE_LANGUAGE_NAMES,
  SUPPORTED_LANGUAGES,
  apiErrorMessage,
  applyLanguagePreference,
  detectBrowserLanguage,
  isLanguagePreference,
  previewLanguagePreference,
  setLanguagePreviewDirty,
  type LanguagePreference,
} from "../i18n";
import { SettingsSection } from "../settings/SettingsSection";
import { SettingsActionBar } from "../settings/SettingsActionBar";
import { useNavigationWarning } from "../settings/useNavigationWarning";

const APPEARANCE_KEY = "preference.appearance";
const SPECIAL_KEYS = [APPEARANCE_KEY, LANGUAGE_PREFERENCE_KEY];

export function PreferencesPage() {
  const { t } = useTranslation("account");
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
  // The draft language previews live, so leaving without saving must put the
  // saved language back.
  const savedLanguage = useRef<unknown>(undefined);
  useEffect(() => {
    savedLanguage.current = baseline?.[LANGUAGE_PREFERENCE_KEY];
  }, [baseline]);
  useEffect(
    () => () => {
      setLanguagePreviewDirty(false);
      if (isLanguagePreference(savedLanguage.current)) {
        previewLanguagePreference(savedLanguage.current);
      }
    },
    [],
  );
  const languageDirty =
    Boolean(baseline) &&
    isLanguagePreference(baseline?.[LANGUAGE_PREFERENCE_KEY]) &&
    isLanguagePreference(draft[LANGUAGE_PREFERENCE_KEY]) &&
    baseline?.[LANGUAGE_PREFERENCE_KEY] !== draft[LANGUAGE_PREFERENCE_KEY];
  useEffect(() => {
    setLanguagePreviewDirty(languageDirty);
  }, [languageDirty]);
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
    t("preferences.leaveWarning"),
  );
  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.updatePreferences(revision, values, auth.status?.csrfToken ?? ""),
    onSuccess: (data) => {
      setLanguagePreviewDirty(false);
      const savedLanguage = data.values[LANGUAGE_PREFERENCE_KEY];
      if (isLanguagePreference(savedLanguage)) {
        applyLanguagePreference(savedLanguage);
      }
      setBaseline(data.values);
      setDraft(data.values);
      setRevision(data.revision);
      setSaved(t("preferences.saved"));
      client.setQueryData(["preferences"], data);
    },
  });
  const reload = () => {
    setLanguagePreviewDirty(false);
    setBaseline(undefined);
    setSaved(undefined);
    void preferences.refetch();
  };
  if (preferences.isLoading)
    return <div className="table-loading">{t("preferences.loading")}</div>;
  const appearance = definitions.find(
    (definition) => definition.key === APPEARANCE_KEY,
  );
  const language = definitions.find(
    (definition) => definition.key === LANGUAGE_PREFERENCE_KEY,
  );
  const rest = definitions.filter(
    (definition) => !SPECIAL_KEYS.includes(definition.key),
  );
  const change = (key: string, value: unknown) => {
    setSaved(undefined);
    setDraft({ ...draft, [key]: value });
  };
  const appearanceRaw =
    draft[APPEARANCE_KEY] ?? appearance?.default ?? "system";
  const appearanceValue =
    typeof appearanceRaw === "string" ? appearanceRaw : "system";
  const languageRaw = draft[LANGUAGE_PREFERENCE_KEY] ?? language?.default;
  const languageValue = isLanguagePreference(languageRaw)
    ? languageRaw
    : "system";
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
      {language && (
        <LanguageControl
          value={languageValue}
          onChange={(value) => change(LANGUAGE_PREFERENCE_KEY, value)}
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
        error={
          isConflict(save.error)
            ? t("preferences.conflict")
            : save.error
              ? apiErrorMessage(save.error)
              : undefined
        }
        onCancel={() => {
          setSaved(undefined);
          setLanguagePreviewDirty(false);
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
  const { t } = useTranslation("account");
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
    system: t("preferences.appearance.system"),
    light: t("preferences.appearance.light"),
    dark: t("preferences.appearance.dark"),
  };
  return (
    <section
      className="grid gap-3 rounded-xl border border-border p-4"
      aria-labelledby="appearance-control-title"
    >
      <div className="grid gap-1">
        <h3 id="appearance-control-title" className="text-base font-semibold">
          {t("preferences.appearance.title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("preferences.appearance.description")}
        </p>
      </div>
      <ToggleGroup
        aria-label={t("preferences.appearance.title")}
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

/**
 * Language options are written in their own language, so the list stays
 * readable whichever language is currently showing.
 */
function LanguageControl({
  value,
  onChange,
}: {
  value: LanguagePreference;
  onChange: (value: LanguagePreference) => void;
}) {
  const { t } = useTranslation("account");
  const systemLabel = t("preferences.language.system", {
    language: NATIVE_LANGUAGE_NAMES[detectBrowserLanguage()],
  });
  const labelFor = (option: LanguagePreference) =>
    option === "system" ? systemLabel : NATIVE_LANGUAGE_NAMES[option];
  return (
    <section
      className="grid gap-3 rounded-xl border border-border p-4"
      aria-labelledby="language-control-title"
    >
      <div className="grid gap-1">
        <h3 id="language-control-title" className="text-base font-semibold">
          {t("preferences.language.title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("preferences.language.description")}
        </p>
      </div>
      <Select
        value={value}
        onValueChange={(next) => {
          if (isLanguagePreference(next)) onChange(next);
        }}
      >
        <SelectTrigger
          aria-label={t("preferences.language.title")}
          className="w-full max-w-xs"
        >
          <SelectValue>{labelFor(value)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="system">{systemLabel}</SelectItem>
          {SUPPORTED_LANGUAGES.map((option) => (
            <SelectItem key={option} value={option} lang={option}>
              {NATIVE_LANGUAGE_NAMES[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
  // Absent until preferences load; applying the "system" default then would
  // briefly switch away from the cached language.
  const language = values[LANGUAGE_PREFERENCE_KEY];
  if (isLanguagePreference(language)) previewLanguagePreference(language);
}
