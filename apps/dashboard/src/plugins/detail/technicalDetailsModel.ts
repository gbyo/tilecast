import type { PluginsT } from "../pluginCatalog";

export type TechnicalRow = {
  key: string;
  label: string;
  /** One value, or several, shown one per line. */
  values: string[];
};

export type TechnicalInput = {
  packageId?: string;
  digest?: string;
  registry?: string;
  signer?: string;
  releaseTag?: string;
  runtimeModule?: string;
  source?: string;
  /** Raw background job ids, which the page shows by friendly name. */
  jobIds?: string[];
  /** Exact contribution identifiers and paths. */
  contributions?: { kind: string; path: string; id?: string }[];
};

/** The low-level facts about a package, labelled; empty ones are dropped. */
export function technicalRows(
  input: TechnicalInput,
  t: PluginsT,
): TechnicalRow[] {
  const rows: TechnicalRow[] = [];
  const add = (key: string, label: string, values: (string | undefined)[]) => {
    const present = values.filter((value): value is string => !!value);
    if (present.length > 0) rows.push({ key, label, values: present });
  };
  add("packageId", t("storeDetail.technical.packageId"), [input.packageId]);
  add("digest", t("store.detail.digestLabel"), [input.digest]);
  add("registry", t("storeDetail.technical.registry"), [input.registry]);
  add("signer", t("storeDetail.technical.signer"), [input.signer]);
  add("releaseTag", t("storeDetail.technical.releaseTag"), [input.releaseTag]);
  add("source", t("storeDetail.technical.source"), [input.source]);
  add("runtime", t("storeDetail.technical.runtime"), [input.runtimeModule]);
  add("jobs", t("storeDetail.technical.jobIds"), input.jobIds ?? []);
  add(
    "contributions",
    t("storeDetail.technical.contributions"),
    (input.contributions ?? []).map((contribution) =>
      [contribution.kind, contribution.id, contribution.path]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  return rows;
}
