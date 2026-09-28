import { useMemo } from "react";
import { useTranslation } from "react-i18next";

/**
 * A plugin's translations live in plugins/<name>/studio/locales/<lang>.json
 * and form the namespace `plugin.<id>`. English is bundled; other languages
 * load with the rest of Studio's (see ../i18n/index.ts).
 */
export function pluginNamespace(pluginId: string): `plugin.${string}` {
  return `plugin.${pluginId}`;
}

/** The namespace for a locale file path below plugins/. */
export function pluginNamespaceFromPath(path: string): `plugin.${string}` {
  const match = /\/plugins\/([^/]+)\/studio\/locales\//.exec(path);
  if (!match?.[1]) throw new Error(`not a plugin locale path: ${path}`);
  return pluginNamespace(match[1].replaceAll("-", "_"));
}

type PluralSuffix = "_zero" | "_one" | "_two" | "_few" | "_many" | "_other";
type WithoutPlural<Key extends string> =
  Key extends `${infer Base}${PluralSuffix}` ? Base : Key;
type Depth = [never, 0, 1, 2, 3, 4, 5, 6];
/** Dotted keys of a nested locale object, with plural forms folded together. */
export type LocaleKey<
  Resources,
  Prefix extends string = "",
  Remaining extends number = 7,
> = [Remaining] extends [never]
  ? never
  : {
      [Key in keyof Resources & string]: Resources[Key] extends string
        ? WithoutPlural<`${Prefix}${Key}`>
        : LocaleKey<Resources[Key], `${Prefix}${Key}.`, Depth[Remaining]>;
    }[keyof Resources & string];

export type PluginT<Resources> = (
  key: LocaleKey<Resources>,
  options?: Record<string, unknown>,
) => string;

/**
 * `t` for a plugin's own namespace, with its keys checked against the English
 * file the plugin passes in. Pass the imported English JSON only for its type.
 */
export function usePluginTranslation<Resources>(
  pluginId: string,
  english: Resources,
): { t: PluginT<Resources> } {
  void english; // Carries the key type only; English is bundled by resources.ts.
  const { t } = useTranslation();
  // Stable until the language changes, so schemas and memoized values built
  // from it are not rebuilt on every render.
  const pluginT = useMemo(() => {
    const namespace = pluginNamespace(pluginId);
    const translate = t as unknown as (key: string, options?: object) => string;
    return (key: string, options?: Record<string, unknown>) =>
      translate(key, { ...options, ns: namespace });
  }, [t, pluginId]);
  const typed: PluginT<Resources> = pluginT;
  return { t: typed };
}
