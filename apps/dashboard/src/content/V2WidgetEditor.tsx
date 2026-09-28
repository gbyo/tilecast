/**
 * The generic V2 Widget editor
 * (docs/widgets-v2-authoring-and-first-wave.md).
 *
 * A real redesign around one rule: the author picks the look first. The
 * layout is preview-dominant — a large real Widget preview beside an
 * inspector — with an explicit Save in the header instead of a server
 * round-trip on every control. The inspector is driven entirely by the
 * Widget manifest's config-authoring metadata (sections, ordering,
 * conditional visibility, style cards); there is one React editor for
 * every V2 Widget, never one per Widget.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  groupAuthoringFields,
  resolveTheme,
  visibleAuthoringFields,
  type WidgetContext,
} from "@tilecast/widget-sdk";
import { compileComponentConfig } from "@tilecast/widget-sdk/manifest";
import { upgradeAuthorConfiguration } from "@tilecast/widget-sdk/upgrade";
import type {
  WidgetComponentRef,
  WidgetMountState,
} from "@tilecast/widget-sdk/mount";
import { api } from "../api/client";
import type {
  Asset,
  ContentDefinitionField,
  WidgetDefinition,
} from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toast";
import { useOrganizationRegionalProfile } from "../settings/regionalProfile";
import { DefinitionForm } from "./DefinitionForm";
import { PreviewTimeControl } from "./PreviewTimeControl";
import {
  initialPreviewTime,
  parsePreviewTimeInput,
  type PreviewTime,
} from "./previewTime";
import { PreviewClock } from "./previewClock";
import { studioWidgetComponent } from "./studioWidgets";
import { WidgetPreviewHost, type PreviewFrame } from "./WidgetPreviewHost";
import { useWidgetPreviewResources } from "./widgetPreviewResources";
import { captureWidgetPreview } from "./widgetPreviewCapture";
import {
  widgetPreviewConfiguration,
  widgetPreviewDataSourceIds,
  widgetPreviewMedia,
} from "./widgetPreviewSources";
import { widgetSaveErrorMessage } from "./SourceEditors";
import type { ContentDefinitionCatalog } from "../api/types";

export type PreviewSizeKey =
  "landscape" | "portrait" | "strip" | "sidebar" | "small";

export interface PreviewSize {
  readonly key: PreviewSizeKey;
  readonly frame: PreviewFrame;
}

export const PREVIEW_SIZES: readonly PreviewSize[] = [
  { key: "landscape", frame: { width: 960, height: 540 } },
  { key: "portrait", frame: { width: 540, height: 960 } },
  { key: "strip", frame: { width: 960, height: 240 } },
  { key: "sidebar", frame: { width: 360, height: 960 } },
  { key: "small", frame: { width: 320, height: 180 } },
];

const CUSTOM_SIZE_BOUNDS = { min: 120, max: 1920 };

function clampSize(value: number): number {
  if (!Number.isFinite(value)) return CUSTOM_SIZE_BOUNDS.min;
  return Math.max(
    CUSTOM_SIZE_BOUNDS.min,
    Math.min(CUSTOM_SIZE_BOUNDS.max, Math.round(value)),
  );
}

function hourCycleFor(
  timeFormat: string | undefined,
): "locale" | "h12" | "h23" {
  if (timeFormat === "12-hour") return "h12";
  if (timeFormat === "24-hour") return "h23";
  return "locale";
}

export function V2WidgetEditor({
  definition,
  catalog,
  asset,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
}: {
  definition: WidgetDefinition;
  catalog: ContentDefinitionCatalog | undefined;
  asset?: Asset;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (asset: Asset) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const queryClient = useQueryClient();
  const regional = useOrganizationRegionalProfile();
  const component = useMemo(
    () => studioWidgetComponent(catalog, definition.id),
    [catalog, definition.id],
  );
  const [name, setName] = useState(asset?.name ?? definition.name);
  const [description, setDescription] = useState(
    asset?.description ?? definition.description,
  );
  // A saved Widget opens upgraded to the provider's current schema: legacy
  // keys fill the fields their configTemplate maps them to, and keys the
  // provider no longer accepts are left out of the next save
  // (docs/widgets-v2-catalog.md §8).
  const [configuration, setConfiguration] = useState<Record<string, unknown>>(
    () => {
      const saved =
        asset?.widget?.authorConfiguration ??
        asset?.widget?.configuration ??
        definition.defaultConfiguration;
      if (!asset || !component) return saved;
      return upgradeAuthorConfiguration(
        definition.configurationSchema.fields,
        component.configTemplate,
        saved,
        { dropUnknown: true },
      ).configuration;
    },
  );
  const touched = useRef(Boolean(asset));
  const markTouched = (next: Record<string, unknown>) => {
    touched.current = true;
    setConfiguration(next);
  };
  const [previewTime, setPreviewTime] =
    useState<PreviewTime>(initialPreviewTime);
  const [sizeKey, setSizeKey] = useState<PreviewSizeKey | "custom">(
    "landscape",
  );
  const [customSize, setCustomSize] = useState<PreviewFrame>({
    width: 960,
    height: 540,
  });
  const frame =
    PREVIEW_SIZES.find((size) => size.key === sizeKey)?.frame ?? customSize;
  const [mountState, setMountState] = useState<WidgetMountState>({
    state: "pending",
  });
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<PreviewClock | null>(null);
  if (!clockRef.current) clockRef.current = new PreviewClock();
  const clock = clockRef.current;
  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The preview-time control drives the Widget's own clock: fixed instants
  // freeze it, live mode follows the wall clock.
  useEffect(() => {
    if (previewTime.mode !== "fixed") {
      clock.setMode("live");
      return;
    }
    const fixed = parsePreviewTimeInput(previewTime.value);
    if (fixed) clock.setFixed(fixed.getTime());
    else clock.setMode("live");
  }, [clock, previewTime]);

  const managedDataSourceId = asset?.widget?.managedDataSourceId;
  const previewMedia = widgetPreviewMedia(
    definition.configurationSchema.fields,
    widgetPreviewConfiguration(configuration, managedDataSourceId),
  );
  const previewConfiguration = previewMedia.configuration;
  const dataSourceIds = widgetPreviewDataSourceIds(
    definition.configurationSchema.fields,
    previewConfiguration,
    managedDataSourceId,
  );
  const { resources, loading: sourcesLoading } = useWidgetPreviewResources(
    dataSourceIds,
    dataSourceIds,
    previewMedia.media,
  );

  // Ordinary form edits compile the component config locally and update the
  // mounted element in place. The Server is not involved until Save, which
  // stays authoritative for persisted state.
  const compiled = useMemo((): {
    ref?: WidgetComponentRef;
    problem?: string;
  } => {
    if (!component) return {};
    try {
      const config = compileComponentConfig(
        component.configTemplate,
        previewConfiguration,
      );
      return {
        ref: { type: component.type, version: component.version, config },
      };
    } catch (error) {
      return {
        problem:
          error instanceof Error ? error.message : "Configuration is invalid.",
      };
    }
  }, [component, previewConfiguration]);

  const context: WidgetContext = useMemo(
    () => ({
      clock,
      locale: regional.locale ?? "en-US",
      timeZone: regional.timezone ?? "UTC",
      hourCycle: hourCycleFor(regional.timeFormat),
      theme: resolveTheme({
        background: configuration["backgroundColor"],
        foreground: configuration["foregroundColor"],
      }),
      motion: { reduced: reducedMotion },
      mode: "preview" as const,
    }),
    // The clock instance is stable; mode/instant changes rebuild context so
    // the mount reassigns it without remounting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      clock,
      regional.locale,
      regional.timezone,
      regional.timeFormat,
      configuration,
      reducedMotion,
      previewTime.mode,
      previewTime.value,
    ],
  );

  const fields = useMemo(
    () =>
      groupAuthoringFields(
        visibleAuthoringFields(
          definition.configurationSchema.fields,
          configuration,
        ),
      ),
    [definition.configurationSchema.fields, configuration],
  );

  const dirty =
    touched.current ||
    name !== (asset?.name ?? definition.name) ||
    description !== (asset?.description ?? definition.description);
  const previewBlocked =
    !component || compiled.problem !== undefined || sourcesLoading;
  const saveDisabled =
    readOnly ||
    previewBlocked ||
    mountState.state === "pending" ||
    mountState.state === "error" ||
    !name.trim();

  const save = useMutation({
    mutationFn: async () => {
      const input = {
        provider: definition.id,
        name,
        description,
        configuration,
      };
      if (!previewWrapRef.current)
        throw new Error(t("widgets.errors.previewWait"));
      const previewImage = await captureWidgetPreview(previewWrapRef.current);
      const saved = asset
        ? await api.updateWidget(asset.id, input, csrf)
        : await api.createWidget(input, csrf);
      await api.uploadWidgetPreview(saved.id, previewImage, csrf);
      return {
        ...saved,
        thumbnailUrl: `/api/v1/assets/${encodeURIComponent(saved.id)}/thumbnail`,
      };
    },
    onSuccess: (saved) => {
      touched.current = false;
      toast.add({
        title: asset
          ? t("widgets.editors.v2.savedUpdated")
          : t("widgets.editors.v2.savedCreated"),
        type: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
      onSaved(saved);
    },
  });

  if (!component) {
    return (
      <section className="w-full min-w-0 space-y-5">
        <Alert variant="destructive">
          <AlertDescription>
            {t("widgets.editors.v2.unavailable")}
          </AlertDescription>
        </Alert>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("common:actions.back")}
        </Button>
      </section>
    );
  }

  return (
    <section className="v2-editor" aria-labelledby="v2-editor-title">
      <header className="v2-editor__header">
        <div className="v2-editor__title">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common:actions.back")}
          </Button>
          <div>
            <h2 id="v2-editor-title">
              {asset
                ? t("widgets.editors.generic.editTitle", {
                    name: definition.name,
                  })
                : t("widgets.editors.generic.createTitle", {
                    name: definition.name,
                  })}
            </h2>
            <p>{definition.description}</p>
          </div>
        </div>
        <div className="v2-editor__actions">
          {dirty && !readOnly && (
            <span className="v2-editor__dirty">
              {t("widgets.editors.v2.unsaved")}
            </span>
          )}
          {!readOnly && (
            <Button
              disabled={save.isPending || saveDisabled}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("common:actions.saving")
                : t("widgets.editors.generic.saveWidget")}
            </Button>
          )}
        </div>
      </header>
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>
            {widgetSaveErrorMessage(t, save.error)}
          </AlertDescription>
        </Alert>
      )}
      <div className="v2-editor__layout">
        <div className="v2-editor__preview">
          <div className="v2-editor__preview-bar">
            <PreviewSizeControl
              sizeKey={sizeKey}
              onSizeKey={setSizeKey}
              customSize={customSize}
              onCustomSize={setCustomSize}
            />
            <PreviewTimeControl value={previewTime} onChange={setPreviewTime} />
          </div>
          <div ref={previewWrapRef} className="v2-editor__frame">
            {compiled.ref ? (
              <WidgetPreviewHost
                component={compiled.ref}
                resources={resources}
                context={context}
                frame={frame}
                label={t("widgets.editors.generic.previewLabel")}
                onState={setMountState}
              />
            ) : (
              <p role="status">
                {compiled.problem ?? t("widgets.editors.generic.preparing")}
              </p>
            )}
          </div>
          <p className="v2-editor__status" role="status">
            <PreviewMountStatus state={mountState} />
          </p>
        </div>
        <div className="v2-editor__inspector">
          <InspectorSection
            title={t("widgets.editors.generic.detailsTitle")}
            description={t("widgets.editors.generic.detailsHint")}
          >
            <div className="form-grid">
              <Field>
                <FieldLabel htmlFor="v2-widget-name">
                  {t("widgets.editors.generic.widgetName")}
                </FieldLabel>
                <Input
                  id="v2-widget-name"
                  value={name}
                  disabled={readOnly}
                  maxLength={180}
                  onChange={(event) => setName(event.target.value)}
                />
                <FieldDescription>
                  {t("widgets.editors.generic.widgetNameHint")}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="v2-widget-description">
                  {t("widgets.editors.generic.description")}
                </FieldLabel>
                <Textarea
                  id="v2-widget-description"
                  value={description}
                  disabled={readOnly}
                  maxLength={2000}
                  onChange={(event) => setDescription(event.target.value)}
                />
                <FieldDescription>
                  {t("widgets.editors.generic.descriptionHint")}
                </FieldDescription>
              </Field>
            </div>
          </InspectorSection>
          {fields.map(({ section, fields: sectionFields }) => (
            <InspectorSection
              key={section}
              title={t(`widgets.editors.v2.sections.${section}`)}
              description={t(`widgets.editors.v2.hints.${section}`)}
            >
              <V2SectionFields
                fields={sectionFields}
                configuration={configuration}
                onConfiguration={markTouched}
                readOnly={readOnly}
                csrf={csrf}
              />
            </InspectorSection>
          ))}
        </div>
      </div>
    </section>
  );
}

function InspectorSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="widget-editor__section">
      <header>
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      <div className="widget-editor__section-body">{children}</div>
    </section>
  );
}

/**
 * One inspector section. Selects flagged as style cards render as visual
 * radio cards; every other control renders through the shared definition
 * form, so V2 Widgets never grow one-off editors.
 */
function V2SectionFields({
  fields,
  configuration,
  onConfiguration,
  readOnly,
  csrf,
}: {
  fields: ContentDefinitionField[];
  configuration: Record<string, unknown>;
  onConfiguration: (next: Record<string, unknown>) => void;
  readOnly: boolean;
  csrf: string;
}) {
  const { t } = useTranslation(["content", "common"]);
  const set = (key: string, next: unknown) =>
    onConfiguration({ ...configuration, [key]: next });
  const cards = fields.filter(
    (field) =>
      field.control === "select" &&
      typeof field.ui === "object" &&
      field.ui !== null &&
      (field.ui as { styleCard?: unknown }).styleCard === true,
  );
  const rest = fields.filter((field) => !cards.includes(field));
  return (
    <div className="grid gap-4">
      {cards.map((field) => (
        <StyleCardGroup
          key={field.key}
          field={field}
          value={configuration[field.key]}
          onChange={(next) => set(field.key, next)}
          readOnly={readOnly}
        />
      ))}
      {rest.length > 0 && (
        <DefinitionForm
          fields={rest}
          value={configuration}
          onChange={(value) => {
            // DefinitionForm reports the whole value for its own subset;
            // merge it back so sibling subsets (like style cards) survive.
            const next = { ...configuration };
            for (const field of rest) {
              if (Object.hasOwn(value, field.key)) {
                next[field.key] = value[field.key];
              }
            }
            onConfiguration(next);
          }}
          readOnly={readOnly}
          csrf={csrf}
        />
      )}
      {cards.length === 0 && rest.length === 0 && (
        <p>{t("widgets.editors.v2.noControls")}</p>
      )}
    </div>
  );
}

function StyleCardGroup({
  field,
  value,
  onChange,
  readOnly,
}: {
  field: ContentDefinitionField;
  value: unknown;
  onChange: (next: unknown) => void;
  readOnly: boolean;
}) {
  const groupId = `v2-style-${field.key}`;
  return (
    <fieldset className="v2-editor__cards">
      <legend>
        {field.label}
        {field.required ? " *" : ""}
      </legend>
      {field.description && <p>{field.description}</p>}
      <div
        className="v2-editor__cards-options"
        role="radiogroup"
        aria-label={field.label}
      >
        {(field.options ?? []).map((option) => {
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              className={`v2-editor__card${selected ? " v2-editor__card--selected" : ""}`}
            >
              <input
                type="radio"
                name={groupId}
                value={option.value}
                checked={selected}
                disabled={readOnly}
                onChange={() => onChange(option.value)}
              />
              <span className="v2-editor__card-label">{option.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function PreviewSizeControl({
  sizeKey,
  onSizeKey,
  customSize,
  onCustomSize,
}: {
  sizeKey: PreviewSizeKey | "custom";
  onSizeKey: (key: PreviewSizeKey | "custom") => void;
  customSize: PreviewFrame;
  onCustomSize: (frame: PreviewFrame) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const widthId = "v2-preview-width";
  const heightId = "v2-preview-height";
  return (
    <div
      className="v2-editor__sizes"
      role="group"
      aria-label={t("widgets.editors.v2.sizeLabel")}
    >
      {PREVIEW_SIZES.map((size) => (
        <Button
          key={size.key}
          type="button"
          variant={sizeKey === size.key ? "default" : "outline"}
          onClick={() => onSizeKey(size.key)}
          aria-pressed={sizeKey === size.key}
        >
          {t(`widgets.editors.v2.sizes.${size.key}`)}
        </Button>
      ))}
      <Button
        type="button"
        variant={sizeKey === "custom" ? "default" : "outline"}
        onClick={() => onSizeKey("custom")}
        aria-pressed={sizeKey === "custom"}
      >
        {t("widgets.editors.v2.sizes.custom")}
      </Button>
      {sizeKey === "custom" && (
        <>
          <Field className="v2-editor__size-field">
            <FieldLabel htmlFor={widthId}>
              {t("widgets.editors.v2.customWidth")}
            </FieldLabel>
            <Input
              id={widthId}
              type="number"
              min={CUSTOM_SIZE_BOUNDS.min}
              max={CUSTOM_SIZE_BOUNDS.max}
              value={customSize.width}
              onChange={(event) =>
                onCustomSize({
                  ...customSize,
                  width: clampSize(Number(event.target.value)),
                })
              }
            />
          </Field>
          <Field className="v2-editor__size-field">
            <FieldLabel htmlFor={heightId}>
              {t("widgets.editors.v2.customHeight")}
            </FieldLabel>
            <Input
              id={heightId}
              type="number"
              min={CUSTOM_SIZE_BOUNDS.min}
              max={CUSTOM_SIZE_BOUNDS.max}
              value={customSize.height}
              onChange={(event) =>
                onCustomSize({
                  ...customSize,
                  height: clampSize(Number(event.target.value)),
                })
              }
            />
          </Field>
        </>
      )}
    </div>
  );
}

function PreviewMountStatus({ state }: { state: WidgetMountState }) {
  const { t } = useTranslation(["content", "common"]);
  if (state.state === "ready")
    return <>{t("widgets.editors.v2.statusReady")}</>;
  if (state.state === "empty")
    return <>{t("widgets.editors.v2.statusEmpty", { reason: state.reason })}</>;
  if (state.state === "error")
    return <>{t("widgets.editors.v2.statusError", { code: state.code })}</>;
  return <>{t("widgets.editors.generic.preparing")}</>;
}
