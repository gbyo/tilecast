// English is the source language: it is bundled, it defines the key types,
// and every other locale must match its keys exactly (see locales.test.ts).
// Add a namespace here, then create the same file in every locale directory.
import common from "../locales/en/common.json";
import navigation from "../locales/en/navigation.json";
import auth from "../locales/en/auth.json";
import errors from "../locales/en/errors.json";
import account from "../locales/en/account.json";
import settings from "../locales/en/settings.json";
import screens from "../locales/en/screens.json";
import content from "../locales/en/content.json";
import review from "../locales/en/review.json";
import playlists from "../locales/en/playlists.json";
import layouts from "../locales/en/layouts.json";
import schedules from "../locales/en/schedules.json";
import activity from "../locales/en/activity.json";
import forms from "../locales/en/forms.json";
import plugins from "../locales/en/plugins.json";
import alerts from "../locales/en/alerts.json";
import { pluginNamespaceFromPath } from "../plugin-host/translation";

export const englishResources = {
  common,
  navigation,
  auth,
  errors,
  account,
  settings,
  screens,
  content,
  review,
  playlists,
  layouts,
  schedules,
  activity,
  forms,
  plugins,
  alerts,
} as const;

export type Namespace = keyof typeof englishResources;

export const NAMESPACES = Object.keys(englishResources) as Namespace[];

// Each plugin brings its own namespace, `plugin.<id>`, from
// plugins/<name>/studio/locales/. Plugin keys are type-checked by
// usePluginTranslation against the plugin's own English file.
const pluginEnglishFiles = import.meta.glob<Record<string, unknown>>(
  "../../../../plugins/*/studio/locales/en.json",
  { eager: true, import: "default" },
);

export const pluginEnglishResources: Record<
  string,
  Record<string, unknown>
> = Object.fromEntries(
  Object.entries(pluginEnglishFiles).map(([path, value]) => [
    pluginNamespaceFromPath(path),
    value,
  ]),
);

export const PLUGIN_NAMESPACES = Object.keys(pluginEnglishResources).sort();
export const DEFAULT_NAMESPACE = "common" satisfies Namespace;
