// Guards every translation against drifting from the English source. A key
// added to English without its Spanish and Russian counterparts fails here,
// as does a placeholder a translator renamed or a missing plural form.
import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "./languages";
import { NAMESPACES } from "./resources";

const files = import.meta.glob<Record<string, unknown>>("../locales/*/*.json", {
  eager: true,
  import: "default",
});

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function locale(language: string, namespace: string) {
  return files[`../locales/${language}/${namespace}.json`];
}

function flatten(
  value: unknown,
  prefix = "",
  into = new Map<string, unknown>(),
) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, into);
    }
  } else {
    into.set(prefix, value);
  }
  return into;
}

function placeholders(text: string) {
  return new Set(
    [...text.matchAll(/\{\{\s*([^,}\s]+)[^}]*\}\}/g)].map((match) => match[1]),
  );
}

function tags(text: string) {
  return [...text.matchAll(/<\/?([\w-]+)\s*\/?>/g)]
    .map((match) => match[0].replace(/\s/g, ""))
    .sort();
}

/** Keys a language must define: plural bases expand to its CLDR categories. */
function expectedKeys(english: Map<string, unknown>, language: string) {
  const categories = new Intl.PluralRules(language).resolvedOptions()
    .pluralCategories;
  const expected = new Map<string, string>();
  for (const key of english.keys()) {
    const base = key.replace(PLURAL_SUFFIX, "");
    if (base === key) {
      expected.set(key, key);
      continue;
    }
    // Plural forms are compared against the English "other" form.
    for (const category of categories) {
      expected.set(`${base}_${category}`, `${base}_other`);
    }
  }
  return expected;
}

describe("locale files", () => {
  const directories = new Set(
    Object.keys(files).map((path) => path.split("/")[2]),
  );

  it("exist for exactly the supported languages", () => {
    expect([...directories].sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
  });

  it("define exactly the registered namespaces in every language", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const present = Object.keys(files)
        .filter((path) => path.split("/")[2] === language)
        .map((path) => path.split("/")[3]!.replace(/\.json$/, ""))
        .sort();
      expect(present, language).toEqual([...NAMESPACES].sort());
    }
  });

  for (const namespace of NAMESPACES) {
    const english = flatten(locale("en", namespace));

    for (const language of SUPPORTED_LANGUAGES) {
      it(`${language}/${namespace}.json matches English`, () => {
        const translated = flatten(locale(language, namespace));
        const expected = expectedKeys(english, language);
        const problems: string[] = [];

        for (const key of expected.keys()) {
          if (!translated.has(key)) problems.push(`missing ${key}`);
        }
        for (const [key, value] of translated) {
          const source = expected.get(key);
          if (!source) {
            problems.push(`unexpected ${key}`);
            continue;
          }
          if (typeof value !== "string" || value.trim() === "") {
            problems.push(`empty or non-string ${key}`);
            continue;
          }
          const sourceText = String(english.get(source));
          const want = placeholders(sourceText);
          const have = placeholders(value);
          const plural = key !== source || PLURAL_SUFFIX.test(key);
          // A singular form may drop {{count}} ("one item"), but no form may
          // introduce a placeholder the code does not pass.
          const unknown = [...have].filter((name) => !want.has(name));
          const dropped = [...want].filter(
            (name) => !have.has(name) && !(plural && name === "count"),
          );
          if (unknown.length) {
            problems.push(`${key} uses unknown {{${unknown.join("}}, {{")}}}`);
          }
          if (dropped.length) {
            problems.push(`${key} drops {{${dropped.join("}}, {{")}}}`);
          }
          if (tags(value).join() !== tags(sourceText).join()) {
            problems.push(`${key} changes markup tags`);
          }
        }
        expect(problems).toEqual([]);
      });
    }
  }
});
