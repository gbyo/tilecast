import { useQueryClient } from "@tanstack/react-query";
import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AppWindow,
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  Group,
  Lock,
  LockOpen,
  Ungroup,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import type {
  Asset,
  DataSource,
  LayoutPlacement,
  LayoutPrimitive,
  Playlist,
} from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button as RheaButton } from "../ui/button";
import { Checkbox as RheaCheckbox } from "../ui/checkbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../ui/accordion";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../ui/combobox";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../ui/input-group";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Slider as RheaSlider } from "../ui/slider";
import { Switch as RheaSwitch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  ToggleGroup as RheaToggleGroup,
  ToggleGroupItem as RheaToggleGroupItem,
} from "../ui/toggle-group";
import {
  ConnectDataNotice,
  DataSourcePicker,
} from "../../content/DataSourcePicker";

const fitOptions = [
  { value: "contain", labelKey: "inspector.fitContain" },
  { value: "cover", labelKey: "inspector.fitCover" },
  { value: "stretch", labelKey: "inspector.fitStretch" },
] as const;

const fallbackVisibilityOptions = [
  { value: "show", labelKey: "inspector.widgetFallbackShow" },
  { value: "hide", labelKey: "inspector.widgetFallbackHide" },
] as const;

const zoneFallbackOptions = [
  { value: "background", labelKey: "inspector.zoneFallbackBackground" },
  { value: "previous", labelKey: "inspector.zoneFallbackPrevious" },
  { value: "hide", labelKey: "inspector.zoneFallbackHide" },
] as const;

const assetFallbackOptions = [
  { value: "hide", labelKey: "inspector.assetFallbackHide" },
  { value: "background", labelKey: "inspector.assetFallbackBackground" },
  { value: "previous", labelKey: "inspector.assetFallbackPrevious" },
] as const;

const visibilityOptions = [
  { value: "always", labelKey: "inspector.visibilityAlways" },
  { value: "field", labelKey: "inspector.visibilityField" },
] as const;

const contentModeOptions = [
  { value: "static", labelKey: "inspector.contentStatic" },
  { value: "dynamic", labelKey: "inspector.contentDynamic" },
] as const;

const formatOptions = [
  { value: "text", labelKey: "inspector.formatText" },
  { value: "date-short", labelKey: "inspector.formatDateShort" },
  { value: "date-long", labelKey: "inspector.formatDateLong" },
  { value: "number", labelKey: "inspector.formatNumber" },
  { value: "integer", labelKey: "inspector.formatInteger" },
  { value: "currency", labelKey: "inspector.formatCurrency" },
] as const;

const fontOptions = [
  // i18n-ignore: font family names are identifiers, not language text
  { value: "Inter", label: "Inter" },
  // i18n-ignore: font family names are identifiers, not language text
  { value: "Roboto", label: "Roboto" },
  // i18n-ignore: font family names are identifiers, not language text
  { value: "Source Sans 3", label: "Source Sans 3" },
  // i18n-ignore: font family names are identifiers, not language text
  { value: "Noto Sans", label: "Noto Sans" },
];

function translatedOptions<const T extends string>(
  options: readonly { value: string; labelKey: T }[],
  t: (key: T) => string,
): { value: string; label: string }[] {
  return options.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
}

const weightOptions = [400, 500, 600, 700, 800].map((weight) => ({
  value: String(weight),
  label: String(weight),
}));

export function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 7680,
  step = 1,
  unit,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}) {
  const id = `layout-number-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${useId()}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number(value.toFixed(2))}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {unit ? (
          <InputGroupAddon align="inline-end">
            <span aria-hidden="true">{unit}</span>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    </Field>
  );
}

// InspectorSection groups inspector controls under a collapsible heading.
// Sections render open so every control keeps working exactly where authors
// expect it; the headings and dividers replace the previous flat stack.
export function InspectorSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <AccordionItem
      value={title}
      className="border-b border-border pb-4 last:border-0 last:pb-0"
    >
      <AccordionTrigger className="cursor-pointer rounded-lg border-0 py-0 hover:no-underline focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring">
        {title}
      </AccordionTrigger>
      <AccordionContent className="grid gap-3 pt-3 pb-0">
        {children}
      </AccordionContent>
    </AccordionItem>
  );
}

function AlignmentToggle({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation("layouts");
  return (
    <Field>
      <FieldLabel id={`${id}-label`}>{label}</FieldLabel>
      <RheaToggleGroup
        aria-labelledby={`${id}-label`}
        value={[value]}
        onValueChange={(values) => {
          const next = values[0];
          if (next) onChange(next);
        }}
        multiple={false}
        variant="outline"
        size="sm"
        spacing={1}
      >
        <RheaToggleGroupItem
          value="left"
          aria-label={`${label}: ${t("inspector.alignLeft")}`}
        >
          <AlignLeft size={15} aria-hidden="true" />
        </RheaToggleGroupItem>
        <RheaToggleGroupItem
          value="center"
          aria-label={`${label}: ${t("inspector.alignCenter")}`}
        >
          <AlignCenter size={15} aria-hidden="true" />
        </RheaToggleGroupItem>
        <RheaToggleGroupItem
          value="right"
          aria-label={`${label}: ${t("inspector.alignRight")}`}
        >
          <AlignRight size={15} aria-hidden="true" />
        </RheaToggleGroupItem>
      </RheaToggleGroup>
    </Field>
  );
}

function InspectorSelect({
  id,
  label,
  value,
  options,
  onChange,
  description,
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
  description?: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <RheaSelect
        value={value}
        onValueChange={(next) => onChange(next ?? value)}
        items={options}
      >
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </RheaSelect>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="color"
        value={value.slice(0, 7)}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

export function PlacementInspector({
  item,
  content,
  playlist,
  dataSources,
  update,
  duplicate,
  group,
  ungroup,
  canGroup,
}: {
  item: LayoutPlacement;
  content?: Asset;
  playlist?: Playlist;
  dataSources: DataSource[];
  update: (change: (item: LayoutPlacement) => void) => void;
  duplicate: () => void;
  group: () => void;
  ungroup: () => void;
  canGroup: boolean;
}) {
  const { t } = useTranslation(["layouts", "common"]);
  const fit = translatedOptions(fitOptions, t);
  const fallbackVisibility = translatedOptions(fallbackVisibilityOptions, t);
  const zoneFallback = translatedOptions(zoneFallbackOptions, t);
  const assetFallback = translatedOptions(assetFallbackOptions, t);
  const visibility = translatedOptions(visibilityOptions, t);
  const contentMode = translatedOptions(contentModeOptions, t);
  const format = translatedOptions(formatOptions, t);
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  // Connecting data from the empty state must also apply the binding, matching what selecting an
  // existing source does. The refreshed list is awaited so the new source's own first field is
  // used, rather than guessing a field name the source may not have.
  const bindNewDataSource = async (
    dataSourceId: string,
    apply: (binding: { dataSourceId: string; field: string }) => void,
  ) => {
    await queryClient.invalidateQueries({ queryKey: ["layout-data-sources"] });
    const refreshed = queryClient.getQueryData<{ items: DataSource[] }>([
      "layout-data-sources",
    ]);
    const created = refreshed?.items?.find(
      (source) => source.id === dataSourceId,
    );
    apply({
      dataSourceId,
      field: (created ? structuredFields(created)[0] : undefined) ?? "title",
    });
  };
  const primitive = item.primitive;
  const openSections = [
    t("inspector.sectionLayer"),
    t("inspector.sectionPosition"),
    t("inspector.sectionAppearance"),
    t("inspector.widgetTitle"),
    t("inspector.zoneTitle"),
    t("inspector.assetTitle"),
    t("inspector.groupTitle"),
    t("inspector.textTitle"),
    t("inspector.shapeTitle"),
  ];
  return (
    <Accordion multiple defaultValue={openSections} className="grid gap-0">
      <InspectorSection title={t("inspector.sectionLayer")}>
        <Field>
          <FieldLabel htmlFor="placement-name">
            {t("inspector.layerName")}
          </FieldLabel>
          <Input
            id="placement-name"
            value={item.name}
            onChange={(event) =>
              update((target) => (target.name = event.target.value))
            }
          />
        </Field>
        <div className="flex flex-wrap gap-1">
          <RheaButton
            type="button"
            variant="ghost"
            size="icon"
            title={t("inspector.moveForward")}
            aria-label={t("inspector.moveForward")}
            onClick={() =>
              update(
                (target) => (target.layer = Math.min(999, target.layer + 1)),
              )
            }
          >
            <ArrowUp size={16} aria-hidden="true" />
          </RheaButton>
          <RheaButton
            type="button"
            variant="ghost"
            size="icon"
            title={t("inspector.moveBackward")}
            aria-label={t("inspector.moveBackward")}
            onClick={() =>
              update((target) => (target.layer = Math.max(0, target.layer - 1)))
            }
          >
            <ArrowDown size={16} aria-hidden="true" />
          </RheaButton>
          <RheaButton
            type="button"
            variant="ghost"
            size="icon"
            title={t("editor.menuDuplicate")}
            aria-label={t("editor.menuDuplicate")}
            onClick={duplicate}
          >
            <Copy size={16} aria-hidden="true" />
          </RheaButton>
          <RheaButton
            type="button"
            variant="ghost"
            size="icon"
            title={item.locked ? t("editor.menuUnlock") : t("editor.menuLock")}
            aria-label={
              item.locked ? t("editor.menuUnlock") : t("editor.menuLock")
            }
            onClick={() => update((target) => (target.locked = !target.locked))}
          >
            {item.locked ? (
              <Lock size={16} aria-hidden="true" />
            ) : (
              <LockOpen size={16} aria-hidden="true" />
            )}
          </RheaButton>
          <RheaButton
            type="button"
            variant="ghost"
            size="icon"
            title={item.visible ? t("editor.menuHide") : t("editor.menuShow")}
            aria-label={
              item.visible ? t("editor.menuHide") : t("editor.menuShow")
            }
            onClick={() =>
              update((target) => (target.visible = !target.visible))
            }
          >
            {item.visible ? (
              <Eye size={16} aria-hidden="true" />
            ) : (
              <EyeOff size={16} aria-hidden="true" />
            )}
          </RheaButton>
        </div>
        {canGroup && (
          <RheaButton type="button" variant="secondary" onClick={group}>
            <Group size={16} aria-hidden="true" />
            {t("editor.menuGroup")}
          </RheaButton>
        )}
      </InspectorSection>
      <InspectorSection title={t("inspector.sectionPosition")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            // i18n-ignore: canvas coordinate abbreviation, not language text
            label="X"
            unit="px"
            value={item.x}
            onChange={(value) => update((target) => (target.x = value))}
          />
          <NumberField
            // i18n-ignore: canvas coordinate abbreviation, not language text
            label="Y"
            unit="px"
            value={item.y}
            onChange={(value) => update((target) => (target.y = value))}
          />
          <NumberField
            label={t("inspector.fields.width")}
            unit="px"
            value={item.width}
            min={1}
            onChange={(value) => update((target) => (target.width = value))}
          />
          <NumberField
            label={t("inspector.fields.height")}
            unit="px"
            value={item.height}
            min={1}
            onChange={(value) => update((target) => (target.height = value))}
          />
        </div>
      </InspectorSection>
      <InspectorSection title={t("inspector.sectionAppearance")}>
        <Field>
          <FieldLabel htmlFor="placement-opacity">
            {t("inspector.opacityLabel")}
          </FieldLabel>
          <div className="flex items-center gap-3">
            <RheaSlider
              id="placement-opacity"
              aria-label={t("inspector.opacityAria")}
              min={0}
              max={100}
              step={1}
              value={[Math.round(item.opacity * 100)]}
              onValueChange={(next) =>
                update(
                  (target) =>
                    (target.opacity =
                      Number(Array.isArray(next) ? (next[0] ?? 100) : next) /
                      100),
                )
              }
              className="flex-1"
            />
            <output className="w-12 shrink-0 text-right text-sm tabular-nums">
              {Math.round(item.opacity * 100)}%
            </output>
          </div>
        </Field>
      </InspectorSection>
      {item.type === "widget" && (
        <InspectorSection title={t("inspector.widgetTitle")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <InspectorSelect
              id="widget-fit"
              label={t("inspector.fitLabel")}
              value={(item.overrides?.fit as string | undefined) ?? "contain"}
              options={fit}
              onChange={(next) =>
                update((target) => {
                  target.overrides = { ...target.overrides, fit: next };
                })
              }
            />
            <AlignmentToggle
              id="widget-alignment"
              label={t("inspector.alignmentLabel")}
              value={
                (item.overrides?.alignment as string | undefined) ?? "center"
              }
              onChange={(next) =>
                update((target) => {
                  target.overrides = { ...target.overrides, alignment: next };
                })
              }
            />
            <ColorField
              id="widget-foreground"
              label={t("inspector.foregroundLabel")}
              value={
                (item.overrides?.foregroundColor as string | undefined) ??
                "#F5F7FA"
              }
              onChange={(next) =>
                update((target) => {
                  target.overrides = {
                    ...target.overrides,
                    foregroundColor: next,
                  };
                })
              }
            />
            <ColorField
              id="widget-background"
              label={t("inspector.fields.background")}
              value={
                (item.overrides?.backgroundColor as string | undefined) ??
                "#18232D"
              }
              onChange={(next) =>
                update((target) => {
                  target.overrides = {
                    ...target.overrides,
                    backgroundColor: next,
                  };
                })
              }
            />
          </div>
          <InspectorSelect
            id="widget-fallback"
            label={t("inspector.whenUnavailable")}
            value={
              (item.overrides?.fallbackVisibility as string | undefined) ??
              "show"
            }
            options={fallbackVisibility}
            onChange={(next) =>
              update((target) => {
                target.overrides = {
                  ...target.overrides,
                  fallbackVisibility: next,
                };
              })
            }
          />
          {(content?.widget?.provider === "website" ||
            content?.widget?.provider === "youtube") && (
            // The wrapping label names the checkbox; no extra aria-label.
            <label className="flex items-center gap-2 text-sm">
              <RheaCheckbox
                checked={(item.overrides?.muted as boolean | undefined) ?? true}
                onCheckedChange={(checked) =>
                  update((target) => {
                    target.overrides = {
                      ...target.overrides,
                      muted: checked === true,
                    };
                  })
                }
              />
              {t("inspector.widgetMuted")}
            </label>
          )}
          {/* Opens the Widget itself and carries a return path, instead of asking for confirmation
              and then abandoning the author at the Widget list. The Widget editor reports its own
              consumers, so the warning this dialog used to guess at is shown where it is
              actionable. */}
          <RheaButton
            type="button"
            variant="secondary"
            disabled={!content}
            onClick={() => {
              if (!content) return;
              void navigate(
                `/widgets/${content.id}?returnTo=${encodeURIComponent(location.pathname)}`,
              );
            }}
          >
            <AppWindow size={16} aria-hidden="true" />
            {t("inspector.widgetEdit")}
          </RheaButton>
        </InspectorSection>
      )}
      {item.type === "playlistZone" && (
        <InspectorSection title={t("inspector.zoneTitle")}>
          <Alert>
            <AlertTitle>{playlist?.name ?? item.name}</AlertTitle>
            <AlertDescription>
              {t("common:count.items", {
                count: playlist?.itemCount ?? 0,
              })}
            </AlertDescription>
          </Alert>
          <div className="grid gap-4 sm:grid-cols-2">
            <InspectorSelect
              id="zone-fit"
              label={t("inspector.fitLabel")}
              value={item.playback?.fit ?? "contain"}
              options={fit}
              onChange={(next) =>
                update((target) => {
                  target.playback = {
                    ...target.playback,
                    fit: next as "contain" | "cover" | "stretch",
                  };
                })
              }
            />
            <InspectorSelect
              id="zone-fallback"
              label={t("inspector.fallbackLabel")}
              value={item.playback?.fallback ?? "background"}
              options={zoneFallback}
              onChange={(next) =>
                update((target) => {
                  target.playback = {
                    ...target.playback,
                    fallback: next as "hide" | "background" | "previous",
                  };
                })
              }
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <RheaCheckbox
              checked={item.playback?.loop ?? true}
              onCheckedChange={(checked) =>
                update((target) => {
                  target.playback = {
                    ...target.playback,
                    loop: checked === true,
                  };
                })
              }
            />
            {t("inspector.zoneLoop")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <RheaCheckbox
              checked={item.playback?.muted ?? true}
              onCheckedChange={(checked) =>
                update((target) => {
                  target.playback = {
                    ...target.playback,
                    muted: checked === true,
                  };
                })
              }
            />
            {t("inspector.mutedOption")}
          </label>
          <NumberField
            label={t("inspector.fields.cornerRadius")}
            unit="px"
            value={item.playback?.cornerRadius ?? 0}
            max={1000}
            onChange={(value) =>
              update((target) => {
                target.playback = { ...target.playback, cornerRadius: value };
              })
            }
          />
          <RheaButton
            type="button"
            variant="secondary"
            onClick={() => void navigate(`/playlists/${item.playlistId}`)}
          >
            {t("inspector.zoneEdit")}
          </RheaButton>
        </InspectorSection>
      )}
      {item.type === "asset" && (
        <InspectorSection title={t("inspector.assetTitle")}>
          <InspectorSelect
            id="asset-fit"
            label={t("inspector.fitLabel")}
            value={item.playback?.fit ?? "contain"}
            options={fit}
            onChange={(next) =>
              update((target) => {
                target.playback = {
                  ...target.playback,
                  fit: next as "contain" | "cover" | "stretch",
                };
              })
            }
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              label={t("inspector.fields.cornerRadius")}
              unit="px"
              value={item.playback?.cornerRadius ?? 0}
              max={1000}
              onChange={(value) =>
                update((target) => {
                  target.playback = {
                    ...target.playback,
                    cornerRadius: value,
                  };
                })
              }
            />
            <InspectorSelect
              id="asset-fallback"
              label={t("inspector.fallbackLabel")}
              value={item.playback?.fallback ?? "hide"}
              options={assetFallback}
              onChange={(next) =>
                update((target) => {
                  target.playback = {
                    ...target.playback,
                    fallback: next as "hide" | "background" | "previous",
                  };
                })
              }
            />
          </div>
          {content?.type === "video" && (
            <>
              <label className="flex items-start gap-2 text-sm">
                <RheaSwitch
                  checked={item.playback?.muted ?? true}
                  onCheckedChange={(checked) =>
                    update((target) => {
                      target.playback = {
                        ...target.playback,
                        muted: checked === true,
                      };
                    })
                  }
                  className="mt-0.5"
                />
                <span>{t("inspector.mutedOption")}</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <RheaSwitch
                  checked={item.playback?.loop ?? true}
                  onCheckedChange={(checked) =>
                    update((target) => {
                      target.playback = {
                        ...target.playback,
                        loop: checked === true,
                      };
                    })
                  }
                  className="mt-0.5"
                />
                <span>{t("inspector.loopOption")}</span>
              </label>
            </>
          )}
        </InspectorSection>
      )}
      {primitive?.kind === "group" && (
        <InspectorSection title={t("inspector.groupTitle")}>
          <RheaButton type="button" variant="secondary" onClick={ungroup}>
            <Ungroup size={16} aria-hidden="true" />
            {t("editor.menuUngroup")}
          </RheaButton>
          {!primitive.binding && dataSources.length === 0 ? (
            <ConnectDataNotice
              message={t("inspector.groupConnectHint")}
              csrf={csrf}
              onCreated={(dataSourceId) =>
                void bindNewDataSource(dataSourceId, (binding) =>
                  update((target) => {
                    target.primitive!.binding = {
                      ...binding,
                      hideWhenEmpty: true,
                    };
                  }),
                )
              }
            />
          ) : (
            <InspectorSelect
              id="group-visibility"
              label={t("inspector.visibilityLabel")}
              value={primitive.binding ? "field" : "always"}
              options={visibility}
              onChange={(next) =>
                update((target) => {
                  if (next === "always") {
                    delete target.primitive!.binding;
                    return;
                  }
                  const source = dataSources[0];
                  if (source)
                    target.primitive!.binding = {
                      dataSourceId: source.id,
                      field: structuredFields(source)[0] ?? "title",
                      hideWhenEmpty: true,
                    };
                })
              }
            />
          )}
          {primitive.binding && (
            <div className="grid gap-4 sm:grid-cols-2">
              <DataSourcePicker
                value={primitive.binding.dataSourceId}
                sources={dataSources}
                csrf={csrf}
                allowEmpty={false}
                onChange={(dataSourceId) =>
                  update(
                    (target) =>
                      (target.primitive!.binding!.dataSourceId = dataSourceId),
                  )
                }
              />
              <BindingFieldSelect
                id="group-field"
                value={primitive.binding.field}
                fields={structuredFields(
                  dataSources.find(
                    (asset) => asset.id === primitive.binding!.dataSourceId,
                  ),
                )}
                onChange={(next) =>
                  update((target) => (target.primitive!.binding!.field = next))
                }
              />
            </div>
          )}
        </InspectorSection>
      )}
      {primitive?.kind === "text" && (
        <InspectorSection title={t("inspector.textTitle")}>
          {!primitive.binding && dataSources.length === 0 ? (
            <ConnectDataNotice
              message={t("inspector.textConnectHint")}
              csrf={csrf}
              onCreated={(dataSourceId) =>
                void bindNewDataSource(dataSourceId, (binding) =>
                  update((target) => {
                    target.primitive!.binding = {
                      ...binding,
                      format: "text",
                    };
                  }),
                )
              }
            />
          ) : (
            <InspectorSelect
              id="text-content-mode"
              label={t("inspector.contentModeLabel")}
              value={primitive.binding ? "dynamic" : "static"}
              options={contentMode}
              onChange={(next) =>
                update((target) => {
                  if (next === "static") {
                    delete target.primitive!.binding;
                    return;
                  }
                  const source = dataSources[0];
                  if (source)
                    target.primitive!.binding = {
                      dataSourceId: source.id,
                      field: structuredFields(source)[0] ?? "title",
                      format: "text",
                    };
                })
              }
            />
          )}
          {primitive.binding && (
            <div className="grid gap-4">
              <DataSourcePicker
                value={primitive.binding.dataSourceId}
                sources={dataSources}
                csrf={csrf}
                allowEmpty={false}
                onChange={(dataSourceId) =>
                  update((target) => {
                    const source = dataSources.find(
                      (asset) => asset.id === dataSourceId,
                    );
                    target.primitive!.binding = {
                      ...target.primitive!.binding!,
                      dataSourceId,
                      field: source
                        ? (structuredFields(source)[0] ?? "title")
                        : "title",
                    };
                  })
                }
              />
              <BindingFieldSelect
                id="text-field"
                value={primitive.binding.field}
                fields={structuredFields(
                  dataSources.find(
                    (asset) => asset.id === primitive.binding!.dataSourceId,
                  ),
                )}
                onChange={(next) =>
                  update((target) => (target.primitive!.binding!.field = next))
                }
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="text-prefix">
                    {t("inspector.prefixLabel")}
                  </FieldLabel>
                  <Input
                    id="text-prefix"
                    value={primitive.binding.prefix ?? ""}
                    onChange={(event) =>
                      update(
                        (target) =>
                          (target.primitive!.binding!.prefix =
                            event.target.value),
                      )
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="text-suffix">
                    {t("inspector.suffixLabel")}
                  </FieldLabel>
                  <Input
                    id="text-suffix"
                    value={primitive.binding.suffix ?? ""}
                    onChange={(event) =>
                      update(
                        (target) =>
                          (target.primitive!.binding!.suffix =
                            event.target.value),
                      )
                    }
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="text-fallback">
                  {t("inspector.fallbackTextLabel")}
                </FieldLabel>
                <Input
                  id="text-fallback"
                  value={primitive.binding.fallbackText ?? ""}
                  onChange={(event) =>
                    update(
                      (target) =>
                        (target.primitive!.binding!.fallbackText =
                          event.target.value),
                    )
                  }
                />
              </Field>
              <InspectorSelect
                id="text-format"
                label={t("inspector.formatLabel")}
                value={primitive.binding.format ?? "text"}
                options={format}
                onChange={(next) =>
                  update(
                    (target) =>
                      (target.primitive!.binding!.format = next as NonNullable<
                        LayoutPrimitive["binding"]
                      >["format"]),
                  )
                }
              />
              <label className="flex items-start gap-2 text-sm">
                <RheaSwitch
                  checked={primitive.binding.hideWhenEmpty ?? false}
                  onCheckedChange={(checked) =>
                    update(
                      (target) =>
                        (target.primitive!.binding!.hideWhenEmpty =
                          checked === true),
                    )
                  }
                  className="mt-0.5"
                />
                <span>{t("inspector.hideWhenEmpty")}</span>
              </label>
            </div>
          )}
          {!primitive.binding && (
            <Field>
              <FieldLabel htmlFor="text-static">
                {t("inspector.staticTextLabel")}
              </FieldLabel>
              <Textarea
                id="text-static"
                value={primitive.text ?? ""}
                onChange={(event) =>
                  update((target) => {
                    target.primitive!.text = event.target.value;
                  })
                }
              />
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <InspectorSelect
              id="text-font"
              label={t("inspector.fontLabel")}
              value={primitive.fontFamily ?? "Inter"}
              options={fontOptions}
              onChange={(next) =>
                update(
                  (target) =>
                    (target.primitive!.fontFamily =
                      next as LayoutPrimitive["fontFamily"]),
                )
              }
            />
            <NumberField
              unit="px"
              label={t("inspector.sizeLabel")}
              value={primitive.fontSize ?? 48}
              min={8}
              max={600}
              onChange={(value) =>
                update((target) => (target.primitive!.fontSize = value))
              }
            />
            <InspectorSelect
              id="text-weight"
              label={t("inspector.weightLabel")}
              value={String(primitive.fontWeight)}
              options={weightOptions}
              onChange={(next) =>
                update(
                  (target) =>
                    (target.primitive!.fontWeight = Number(
                      next,
                    ) as LayoutPrimitive["fontWeight"]),
                )
              }
            />
            <AlignmentToggle
              id="text-align"
              label={t("inspector.alignLabel")}
              value={primitive.textAlign ?? "center"}
              onChange={(next) =>
                update(
                  (target) =>
                    (target.primitive!.textAlign =
                      next as LayoutPrimitive["textAlign"]),
                )
              }
            />
            <ColorField
              id="text-color"
              label={t("inspector.textColorLabel")}
              value={primitive.color ?? "#000000"}
              onChange={(next) =>
                update((target) => (target.primitive!.color = next))
              }
            />
            <ColorField
              id="text-background"
              label={t("inspector.fields.background")}
              value={primitive.backgroundColor ?? "#000000"}
              onChange={(next) =>
                update((target) => (target.primitive!.backgroundColor = next))
              }
            />
            <NumberField
              label={t("inspector.lineHeightLabel")}
              value={primitive.lineHeight ?? 1.2}
              min={0.8}
              max={3}
              step={0.1}
              onChange={(value) =>
                update((target) => (target.primitive!.lineHeight = value))
              }
            />
            <NumberField
              unit="px"
              label={t("inspector.letterSpacingLabel")}
              value={primitive.letterSpacing ?? 0}
              min={0}
              max={40}
              step={0.5}
              onChange={(value) =>
                update((target) => (target.primitive!.letterSpacing = value))
              }
            />
            <NumberField
              unit="px"
              label={t("inspector.paddingLabel")}
              value={primitive.padding ?? 0}
              max={300}
              onChange={(value) =>
                update((target) => (target.primitive!.padding = value))
              }
            />
            <NumberField
              label={t("inspector.fields.cornerRadius")}
              unit="px"
              value={primitive.cornerRadius ?? 0}
              max={1000}
              onChange={(value) =>
                update((target) => (target.primitive!.cornerRadius = value))
              }
            />
            <NumberField
              label={t("inspector.borderLabel")}
              unit="px"
              value={primitive.borderWidth ?? 0}
              max={100}
              onChange={(value) =>
                update((target) => (target.primitive!.borderWidth = value))
              }
            />
            <NumberField
              label={t("inspector.maxLinesLabel")}
              value={primitive.maximumLines ?? 4}
              min={1}
              max={100}
              onChange={(value) =>
                update((target) => (target.primitive!.maximumLines = value))
              }
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <RheaSwitch
              checked={primitive.autoFit ?? false}
              onCheckedChange={(checked) =>
                update(
                  (target) => (target.primitive!.autoFit = checked === true),
                )
              }
              className="mt-0.5"
            />
            <span>{t("inspector.autoFitLabel")}</span>
          </label>
        </InspectorSection>
      )}
      {primitive &&
        ["rectangle", "circle", "line"].includes(primitive.kind) && (
          <InspectorSection title={t("inspector.shapeTitle")}>
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField
                id="shape-fill"
                label={t("inspector.fillLabel")}
                value={primitive.fillColor ?? "#2D7FF9"}
                onChange={(next) =>
                  update((target) => (target.primitive!.fillColor = next))
                }
              />
              <ColorField
                id="shape-stroke"
                label={t("inspector.strokeLabel")}
                value={primitive.strokeColor ?? "#FFFFFF"}
                onChange={(next) =>
                  update((target) => (target.primitive!.strokeColor = next))
                }
              />
              <NumberField
                label={t("inspector.strokeWidthLabel")}
                unit="px"
                value={primitive.strokeWidth ?? 0}
                max={100}
                onChange={(value) =>
                  update((target) => (target.primitive!.strokeWidth = value))
                }
              />
            </div>
          </InspectorSection>
        )}
    </Accordion>
  );
}

function BindingFieldSelect({
  id,
  value,
  fields,
  onChange,
}: {
  id: string;
  value: string;
  fields: string[];
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation("layouts");
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("inspector.fieldLabel")}</FieldLabel>
      <Combobox
        items={fields}
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string" && next) onChange(next);
        }}
      >
        <ComboboxInput
          id={id}
          aria-label={t("inspector.fieldLabel")}
          placeholder={t("inspector.fieldSearch")}
        />
        <ComboboxContent>
          <ComboboxEmpty>{t("inspector.fieldEmpty")}</ComboboxEmpty>
          <ComboboxList>
            {(field: string) => (
              <ComboboxItem key={field} value={field}>
                {field}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </Field>
  );
}

export function structuredFields(source?: DataSource): string[] {
  if (!source || !["csv", "json"].includes(source.provider)) return [];
  const config = source.configuration as {
    mapping?: { valueFields?: Record<string, string> };
  };
  return [
    "title",
    "subtitle",
    "date",
    "author",
    "description",
    ...Object.keys(config.mapping?.valueFields ?? {}),
  ];
}
