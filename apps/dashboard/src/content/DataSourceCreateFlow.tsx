// The one Data Source creation flow: choose a provider from the catalog gallery, then run
// its editor beside the setup guidance for that provider.
//
// It lives under content/ rather than in the Data Sources page because creating data from
// inside a Widget or a Layout must be the same flow, not a reduced copy of it. Before this
// module, the in-editor path offered a plain provider list and a bare editor while the page
// offered the gallery and the setup checklist, so the two surfaces taught authors different
// things about the same task.
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, Lightbulb, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { DataSourceDefinition, DataSourceProvider } from "../api/types";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { DataSourceEditor } from "./data-sources/dispatcher";
import {
  galleryDescriptionText,
  localizedSetup,
  providerLabel,
  sourceIcon,
} from "./dataSourceProviderMeta";

function useDataSourceDefinitions(
  providers?: DataSourceProvider[],
  exclude?: DataSourceProvider[],
) {
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: api.contentDefinitions,
    staleTime: 5 * 60_000,
  });
  const all = definitions.data?.dataSources ?? [];
  return {
    isLoading: definitions.isLoading,
    all,
    // An empty or absent list means "everything in the catalog"; a Widget that accepts
    // only some providers must not be offered the rest. Superseded providers
    // remain editable for saved content but leave new creation once their
    // replacement proves parity.
    offered: all.filter(
      (definition) =>
        !definition.deprecation?.deprecated &&
        (!providers?.length || providers.includes(definition.id)) &&
        !exclude?.includes(definition.id),
    ),
  };
}

export function DataSourceProviderGallery({
  providers,
  exclude,
  description,
  onChoose,
  onClose,
  page = false,
}: {
  providers?: DataSourceProvider[];
  // Providers this surface must never offer, whatever the catalog contains.
  exclude?: DataSourceProvider[];
  description?: string;
  onChoose: (provider: DataSourceProvider) => void;
  onClose: () => void;
  page?: boolean;
}) {
  const { t } = useTranslation(["content", "common"]);
  const definitions = useDataSourceDefinitions(providers, exclude);
  const pluginCatalog = useQuery({
    queryKey: ["plugins"],
    queryFn: api.plugins,
    staleTime: 5 * 60_000,
  });
  // Provenance for plugin-owned Data Sources, mirroring the Widget
  // gallery: the gallery is built from the effective catalog, and
  // installation state decides whether a plugin-owned provider can be
  // created. An uninstalled plugin's provider stays visible but disabled
  // with its owning plugin named, so the definition never looks
  // silently broken. The Server enforces the same decision
  // authoritatively; when the plugin catalog cannot be read the gallery
  // degrades to the static catalog alone.
  const installedPlugins = new Map(
    (pluginCatalog.data?.items ?? []).map((plugin) => [plugin.id, plugin]),
  );
  const sourceInfo = (definition: DataSourceDefinition) => {
    const source = definition.source;
    if (!source || source.kind !== "plugin") return null;
    const plugin = installedPlugins.get(source.pluginId);
    const name = plugin?.name ?? source.pluginId;
    if (plugin && !plugin.installed) {
      return {
        badge: t("dataSources.createFlow.sourcePlugin", { name }),
        unavailable: t("dataSources.createFlow.requiresPlugin", { name }),
      };
    }
    return {
      badge: t("dataSources.createFlow.sourcePlugin", { name }),
      unavailable: null as string | null,
    };
  };
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (page) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    addEventListener("keydown", escape);
    return () => removeEventListener("keydown", escape);
  }, [page, onClose]);
  // As a modal, the gallery has to take focus and keep it: opening it from a Widget editor
  // otherwise leaves the caret behind in the form underneath, where Tab walks controls the
  // author cannot see. Matches the Drawer primitive's handling.
  useEffect(() => {
    if (page) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current
      ?.querySelector<HTMLElement>("button, [href], input, select, textarea")
      ?.focus();
    return () => previousFocus?.focus();
  }, [page]);
  const trapTab = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (page || event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  return (
    <div
      className={
        page
          ? "grid w-full min-w-0 gap-5"
          : "fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4"
      }
      role={page ? undefined : "presentation"}
    >
      <section
        ref={dialogRef}
        className={
          page
            ? "grid w-full min-w-0 gap-5"
            : "mx-auto grid w-full max-w-3xl gap-5 rounded-xl bg-background p-5"
        }
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : true}
        aria-labelledby="data-source-gallery-title"
        onKeyDown={trapTab}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2
              id="data-source-gallery-title"
              className="text-xl font-semibold"
            >
              {t("dataSources.createFlow.galleryTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {description ??
                t("dataSources.createFlow.galleryDescription", {
                  count: definitions.offered.length,
                })}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("common:actions.close")}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {definitions.offered.map((definition) => {
            const provenance = sourceInfo(definition);
            const disabled = provenance?.unavailable != null;
            return (
              <Button
                type="button"
                key={definition.id}
                variant="outline"
                className="h-auto flex-col items-start gap-1 p-4 text-left"
                disabled={disabled}
                aria-describedby={
                  disabled
                    ? `data-source-availability-${definition.id}`
                    : undefined
                }
                onClick={() => onChoose(definition.id)}
              >
                {sourceIcon(definition.id, definition, 30)}
                <strong className="text-sm">{definition.name}</strong>
                <span className="text-xs font-normal text-muted-foreground">
                  {galleryDescriptionText(definition)}
                </span>
                {provenance?.badge && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {provenance.badge}
                  </span>
                )}
                {disabled && provenance?.unavailable && (
                  <small
                    id={`data-source-availability-${definition.id}`}
                    className="text-xs font-normal text-muted-foreground"
                  >
                    {provenance.unavailable}
                  </small>
                )}
              </Button>
            );
          })}
        </div>
        {!definitions.isLoading && definitions.offered.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t("dataSources.createFlow.noProviders")}
          </p>
        )}
      </section>
    </div>
  );
}

export function DataSourceCreateShell({
  provider,
  definition,
  csrf,
  backLabel: backLabelProp,
  onClose,
  onSaved,
}: {
  provider: DataSourceProvider;
  definition?: DataSourceDefinition;
  csrf: string;
  backLabel?: string;
  onClose: () => void;
  onSaved: (value: { id: string }) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const backLabel = backLabelProp ?? t("dataSources.createFlow.backDefault");
  const copy = localizedSetup(provider, definition);
  const label =
    definition && !definition.legacyEditor
      ? definition.name
      : providerLabel(provider, t);
  return (
    <div className="grid w-full min-w-0 gap-5">
      <div className="grid gap-4">
        <Button type="button" variant="ghost" onClick={onClose}>
          <ArrowLeft size={16} aria-hidden="true" /> {backLabel}
        </Button>
        <div className="flex items-start gap-3">
          <span className="text-muted-foreground">
            {sourceIcon(provider, definition)}
          </span>
          <div className="space-y-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {copy.eyebrow}
            </p>
            <h2 className="text-xl font-semibold">
              {t("dataSources.createFlow.createTitle", { label })}
            </h2>
            <p className="text-sm text-muted-foreground">{copy.description}</p>
          </div>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside
          className="grid content-start gap-4 rounded-xl border p-4"
          aria-label={t("dataSources.createFlow.setupGuidance")}
        >
          {copy.steps.length > 0 && (
            <div className="grid gap-2">
              <h3 className="text-sm font-medium">
                {t("dataSources.createFlow.checklistTitle")}
              </h3>
              <ol className="grid gap-2">
                {copy.steps.map((step, index) => (
                  <li key={step} className="flex items-start gap-2 text-sm">
                    <span className="grid size-5 shrink-0 place-content-center rounded-full bg-muted text-xs font-medium">
                      {index + 1}
                    </span>
                    <p className="text-muted-foreground">{step}</p>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {copy.tip && (
            <div className="flex items-start gap-2 rounded-lg bg-muted p-3">
              <Lightbulb size={17} aria-hidden="true" className="shrink-0" />
              <div className="grid gap-1">
                <strong className="text-sm">
                  {t("dataSources.createFlow.goodToKnow")}
                </strong>
                <p className="text-sm text-muted-foreground">{copy.tip}</p>
              </div>
            </div>
          )}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Check size={15} aria-hidden="true" className="shrink-0" />{" "}
            {t("dataSources.createFlow.advancedNote")}
          </p>
        </aside>
        <div className="grid min-w-0 content-start">
          <DataSourceEditor
            provider={provider}
            csrf={csrf}
            onClose={onClose}
            onSaved={onSaved}
            page
          />
        </div>
      </div>
    </div>
  );
}

// ConnectDataFlow runs the same gallery and the same guided create shell inside a dialog,
// so connecting data from a Widget or a Layout never navigates away from work in progress.
export function ConnectDataFlow({
  provider,
  providers,
  exclude,
  csrf,
  onChooseProvider,
  onBack,
  onClose,
  onCreated,
}: {
  // The provider chosen so far. Undefined means the gallery step.
  provider?: DataSourceProvider;
  providers?: DataSourceProvider[];
  exclude?: DataSourceProvider[];
  csrf: string;
  onChooseProvider: (provider: DataSourceProvider) => void;
  onBack: () => void;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const definitions = useDataSourceDefinitions(providers, exclude);
  const definition = definitions.all.find(
    (candidate) => candidate.id === provider,
  );
  const dialogLabel =
    definition && !definition.legacyEditor
      ? definition.name
      : provider !== undefined
        ? providerLabel(provider, t)
        : "";
  const dialogContentRef = useRef<HTMLDivElement>(null);
  const previousProvider = useRef(provider);
  useEffect(() => {
    if (previousProvider.current === provider) return;
    previousProvider.current = provider;
    dialogContentRef.current
      ?.querySelector<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )
      ?.focus();
  }, [provider]);
  const dialogDescription = t("dataSources.createFlow.connectDescription");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        ref={dialogContentRef}
        showCloseButton={provider !== undefined}
        className={
          provider === undefined
            ? "max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-2rem))] max-w-none overflow-y-auto"
            : "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:w-[calc(100vw-2rem)] sm:max-w-5xl"
        }
      >
        <DialogHeader className="sr-only">
          <DialogTitle render={<div />}>
            {provider === undefined
              ? t("dataSources.createFlow.galleryTitle")
              : t("dataSources.createFlow.createTitle", {
                  label: dialogLabel,
                })}
          </DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>
        {provider === undefined ? (
          <DataSourceProviderGallery
            providers={providers}
            exclude={exclude}
            description={dialogDescription}
            onChoose={onChooseProvider}
            onClose={onClose}
            page
          />
        ) : (
          <DataSourceCreateShell
            provider={provider}
            definition={definition}
            csrf={csrf}
            backLabel={t("dataSources.createFlow.backAll")}
            onClose={onBack}
            onSaved={(created) => onCreated(created.id)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
