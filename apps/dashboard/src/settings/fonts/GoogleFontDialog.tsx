import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import {
  fontCatalogPreviewUrl,
  getFontCatalogFamily,
  importGoogleFont,
  searchFontCatalog,
} from "../../api/fonts";
import type {
  FontCatalogCategory,
  FontCatalogEntry,
  FontCatalogFamily,
  FontFamily,
} from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Field,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Spinner } from "../../components/ui/spinner";
import { fontKeys } from "../../data/fonts";
import { registerPreviewFont } from "../../fonts/libraryFonts";
import { useDebouncedValue } from "../../hooks/use-debounced-value";
import { apiErrorMessage } from "../../i18n";

const categories: readonly FontCatalogCategory[] = [
  "sans-serif",
  "serif",
  "display",
  "handwriting",
  "monospace",
  "icons",
];

/** Browse the Google Fonts catalog through the server and copy one family. */
export function GoogleFontDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (family: FontFamily) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<FontCatalogCategory | "all">("all");
  const [selected, setSelected] = useState<string>();
  const query = useDebouncedValue(search.trim(), 250);
  const catalog = useInfiniteQuery({
    queryKey: fontKeys.catalog(query, category),
    queryFn: ({ pageParam, signal }) =>
      searchFontCatalog(
        {
          q: query,
          category: category === "all" ? undefined : category,
          offset: pageParam,
        },
        { signal },
      ),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.families.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    retry: false,
    enabled: !selected,
  });
  const families = catalog.data?.pages.flatMap((page) => page.families) ?? [];
  const total = catalog.data?.pages[0]?.total ?? 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle>{t("fonts.google.title")}</DialogTitle>
          <DialogDescription>{t("fonts.google.description")}</DialogDescription>
        </DialogHeader>
        {selected ? (
          <FamilyOptions
            sourceId={selected}
            onBack={() => setSelected(undefined)}
            onAdded={onAdded}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field className="min-w-[220px] flex-1">
                <FieldLabel htmlFor="font-catalog-search">
                  {t("fonts.google.searchLabel")}
                </FieldLabel>
                <Input
                  id="font-catalog-search"
                  value={search}
                  placeholder={t("fonts.google.searchPlaceholder")}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </Field>
              <Field className="w-[200px]">
                <FieldLabel htmlFor="font-catalog-category">
                  {t("fonts.google.categoryLabel")}
                </FieldLabel>
                <Select
                  value={category}
                  onValueChange={(next) =>
                    setCategory((next as FontCatalogCategory | "all") ?? "all")
                  }
                  items={[
                    { value: "all", label: t("fonts.categories.all") },
                    ...categories.map((value) => ({
                      value,
                      label: t(`fonts.categories.${value}`),
                    })),
                  ]}
                >
                  <SelectTrigger id="font-catalog-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {t("fonts.categories.all")}
                    </SelectItem>
                    {categories.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`fonts.categories.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {catalog.isError ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>
                  {apiErrorMessage(catalog.error)}
                </AlertDescription>
              </Alert>
            ) : catalog.isLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner aria-hidden="true" />
                {t("fonts.google.loading")}
              </p>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <p className="mb-2 text-sm text-muted-foreground" role="status">
                  {t("fonts.google.results", { count: total })}
                </p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {families.map((family) => (
                    <li key={family.id}>
                      <CatalogCard
                        family={family}
                        onSelect={() => setSelected(family.id)}
                      />
                    </li>
                  ))}
                </ul>
                {catalog.hasNextPage && (
                  <div className="mt-3 flex justify-center">
                    <Button
                      variant="outline"
                      disabled={catalog.isFetchingNextPage}
                      onClick={() => void catalog.fetchNextPage()}
                    >
                      {t("fonts.google.more")}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CatalogCard({
  family,
  onSelect,
}: {
  family: FontCatalogEntry;
  onSelect: () => void;
}) {
  const { t } = useTranslation("settings");
  const ref = useRef<HTMLButtonElement>(null);
  const [previewFamily, setPreviewFamily] = useState<string>();
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    // Load the preview face only once the card scrolls into view.
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      const preview = registerPreviewFont(
        family.id,
        fontCatalogPreviewUrl(family.id),
      );
      void preview.loaded.then(() => setPreviewFamily(preview.family));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [family.id]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      className="grid w-full gap-1 rounded-lg border border-border p-3 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span
        className="truncate text-xl"
        style={
          previewFamily
            ? { fontFamily: `"${previewFamily}", var(--font-sans)` }
            : undefined
        }
      >
        {family.family}
      </span>
      <span className="text-xs text-muted-foreground">
        {[
          t(`fonts.categories.${family.category as FontCatalogCategory}`, {
            defaultValue: family.category,
          }),
          family.variable
            ? t("fonts.google.variable")
            : t("fonts.google.styles", { count: family.weights.length }),
          family.license,
        ].join(" · ")}
      </span>
    </button>
  );
}

function FamilyOptions({
  sourceId,
  onBack,
  onAdded,
}: {
  sourceId: string;
  onBack: () => void;
  onAdded: (family: FontFamily) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const detail = useQuery({
    queryKey: fontKeys.catalogFamily(sourceId),
    queryFn: ({ signal }) => getFontCatalogFamily(sourceId, { signal }),
    retry: false,
  });
  return (
    <div className="grid min-h-0 gap-4 overflow-y-auto">
      <div>
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          {t("fonts.google.back")}
        </Button>
      </div>
      {detail.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{apiErrorMessage(detail.error)}</AlertDescription>
        </Alert>
      ) : !detail.data ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />
          {t("fonts.google.loading")}
        </p>
      ) : (
        <FamilySelection family={detail.data} onAdded={onAdded} />
      )}
    </div>
  );
}

function FamilySelection({
  family,
  onAdded,
}: {
  family: FontCatalogFamily;
  onAdded: (family: FontFamily) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [subsets, setSubsets] = useState<string[]>([family.defaultSubset]);
  const [styles, setStyles] = useState<("normal" | "italic")[]>(
    family.styles.includes("normal") ? ["normal"] : ["italic"],
  );
  const defaultWeight = family.weights.includes(400)
    ? 400
    : (family.weights[0] ?? 400);
  const [weights, setWeights] = useState<number[]>([defaultWeight]);
  const add = useMutation({
    mutationFn: () =>
      importGoogleFont(
        {
          sourceId: family.id,
          subsets,
          styles,
          ...(family.weightRange ? {} : { weights }),
        },
        auth.status?.csrfToken ?? "",
      ),
    onSuccess: async (added) => {
      await queryClient.invalidateQueries({ queryKey: fontKeys.library });
      onAdded(added);
    },
  });
  const toggle = <T,>(list: T[], value: T, on: boolean) =>
    on ? [...list, value] : list.filter((entry) => entry !== value);
  const availableStyles = new Set<string>(family.styles);
  const chosenSubsets = new Set(subsets);
  const chosenStyles = new Set(styles);
  const chosenWeights = new Set(weights);
  const ready =
    subsets.length > 0 &&
    styles.length > 0 &&
    (family.weightRange !== null || weights.length > 0);
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate();
      }}
    >
      <div>
        <h3 className="text-lg font-semibold">{family.family}</h3>
        <p className="text-sm text-muted-foreground">
          {t("fonts.google.license", { license: family.license })}
          {family.weightRange
            ? " · " +
              t("fonts.google.weightRange", {
                min: family.weightRange[0],
                max: family.weightRange[1],
              })
            : ""}
        </p>
      </div>
      <FieldSet>
        <FieldLegend variant="label">{t("fonts.google.subsets")}</FieldLegend>
        <div className="grid gap-2 sm:grid-cols-3">
          {family.subsets.map((subset) => (
            <Field
              key={subset}
              orientation="horizontal"
              className="items-center"
            >
              <Checkbox
                id={"font-subset-" + subset}
                checked={chosenSubsets.has(subset)}
                onCheckedChange={(checked) =>
                  setSubsets(toggle(subsets, subset, checked === true))
                }
              />
              <FieldLabel
                htmlFor={"font-subset-" + subset}
                className="font-normal"
              >
                {subset}
              </FieldLabel>
            </Field>
          ))}
        </div>
      </FieldSet>
      <FieldSet>
        <FieldLegend variant="label">
          {t("fonts.google.stylesLabel")}
        </FieldLegend>
        <div className="flex flex-wrap gap-4">
          {(["normal", "italic"] as const)
            .filter((style) => availableStyles.has(style))
            .map((style) => (
              <Field
                key={style}
                orientation="horizontal"
                className="items-center"
              >
                <Checkbox
                  id={"font-style-" + style}
                  checked={chosenStyles.has(style)}
                  onCheckedChange={(checked) =>
                    setStyles(toggle(styles, style, checked === true))
                  }
                />
                <FieldLabel
                  htmlFor={"font-style-" + style}
                  className="font-normal"
                >
                  {t(`fonts.google.style.${style}`)}
                </FieldLabel>
              </Field>
            ))}
        </div>
      </FieldSet>
      {family.weightRange === null && (
        <FieldSet>
          <FieldLegend variant="label">{t("fonts.google.weights")}</FieldLegend>
          <div className="flex flex-wrap gap-4">
            {family.weights.map((weight) => (
              <Field
                key={weight}
                orientation="horizontal"
                className="items-center"
              >
                <Checkbox
                  id={"font-weight-" + weight}
                  checked={chosenWeights.has(weight)}
                  onCheckedChange={(checked) =>
                    setWeights(toggle(weights, weight, checked === true))
                  }
                />
                <FieldLabel
                  htmlFor={"font-weight-" + weight}
                  className="font-normal"
                >
                  {weight}
                </FieldLabel>
              </Field>
            ))}
          </div>
        </FieldSet>
      )}
      <p className="text-sm text-muted-foreground">
        {t("fonts.google.copyNote")}
      </p>
      {add.isError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{apiErrorMessage(add.error)}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="submit" disabled={!ready || add.isPending}>
          {add.isPending && <Spinner aria-hidden="true" />}
          {add.isPending ? t("fonts.google.adding") : t("fonts.google.add")}
        </Button>
      </DialogFooter>
    </form>
  );
}
