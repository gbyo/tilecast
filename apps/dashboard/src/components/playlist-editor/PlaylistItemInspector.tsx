import { AlertCircle, Check, Info, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PlaylistItem, PlaylistItemInput } from "../../api/types";
import { useFormatLocale } from "../../i18n";
import {
  AlertDialog as RheaAlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button as RheaButton } from "../ui/button";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
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
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "../ui/drawer";
import { Slider as RheaSlider } from "../ui/slider";
import { Switch as RheaSwitch } from "../ui/switch";
import {
  itemInput,
  playlistItemUsesFixedDuration,
  transitionLabel,
} from "./playlistEditorModel";

const itemTransitionOptions: {
  value: PlaylistItem["transition"];
  labelKey:
    | "inspector.transitionOptions.none"
    | "inspector.transitionOptions.fade"
    | "inspector.transitionOptions.crossfade";
}[] = [
  { value: "none", labelKey: "inspector.transitionOptions.none" },
  { value: "fade", labelKey: "inspector.transitionOptions.fade" },
  { value: "crossfade", labelKey: "inspector.transitionOptions.crossfade" },
];

const fitModeOptions: {
  value: PlaylistItem["fitMode"];
  labelKey:
    | "inspector.fitOptions.contain"
    | "inspector.fitOptions.cover"
    | "inspector.fitOptions.stretch";
}[] = [
  { value: "contain", labelKey: "inspector.fitOptions.contain" },
  { value: "cover", labelKey: "inspector.fitOptions.cover" },
  { value: "stretch", labelKey: "inspector.fitOptions.stretch" },
];

const deliveryOptions: {
  value: PlaylistItem["deliveryPolicy"];
  labelKey:
    | "inspector.deliveryOptions.download"
    | "inspector.deliveryOptions.stream"
    | "inspector.deliveryOptions.automatic";
}[] = [
  { value: "download", labelKey: "inspector.deliveryOptions.download" },
  { value: "stream", labelKey: "inspector.deliveryOptions.stream" },
  { value: "automatic", labelKey: "inspector.deliveryOptions.automatic" },
];

const widgetBehaviorOptions: {
  value: "until_end" | "fixed_duration";
  labelKey:
    | "inspector.widgetBehavior.untilEnd"
    | "inspector.widgetBehavior.fixedDuration";
}[] = [
  { value: "until_end", labelKey: "inspector.widgetBehavior.untilEnd" },
  {
    value: "fixed_duration",
    labelKey: "inspector.widgetBehavior.fixedDuration",
  },
];

export function PlaylistItemInspector({
  item,
  index,
  open,
  canManage,
  playlistTransition,
  saving,
  error,
  onClose,
  onOpenChangeComplete,
  onChange,
  onDelete,
}: InspectorProps & {
  open: boolean;
  onOpenChangeComplete: (open: boolean) => void;
}) {
  const { t } = useTranslation("playlists");
  return (
    <Drawer
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={onOpenChangeComplete}
      showSwipeHandle
    >
      <DrawerContent className="max-h-[calc(100dvh-2rem)]">
        <DrawerHeader>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("inspector.itemHeading", {
              index: index + 1,
              type: item.assetType,
            })}
          </p>
          <DrawerTitle>{item.assetName}</DrawerTitle>
          <DrawerDescription className="sr-only">
            Edit playlist item settings.
          </DrawerDescription>
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <PlaylistItemInspectorBody
            item={item}
            index={index}
            canManage={canManage}
            playlistTransition={playlistTransition}
            saving={saving}
            error={error}
            onClose={onClose}
            onChange={onChange}
            onDelete={onDelete}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
}

type InspectorProps = {
  item: PlaylistItem;
  index: number;
  canManage: boolean;
  playlistTransition: PlaylistItem["transition"] | "mixed";
  saving: boolean;
  error?: string;
  onClose: () => void;
  onChange: (input: PlaylistItemInput) => void;
  onDelete: () => void;
};

// PlaylistItemInspectorBody is the surface-free inspector content. The
// playlist editor renders it inline in the desktop pane and inside the Drawer
// above on narrow screens.
export function PlaylistItemInspectorBody({
  item,
  canManage,
  playlistTransition,
  saving,
  error,
  onClose,
  onChange,
  onDelete,
}: InspectorProps) {
  const { t } = useTranslation(["playlists", "common"]);
  const formatLocale = useFormatLocale();
  const usesPlayerDefaults = item.usePlayerDefaults === true;
  const editable = canManage && !item.dynamic;
  const itemDeliveryOptions =
    item.assetType === "widget" || item.assetType === "layout"
      ? deliveryOptions.filter((option) => option.value === "stream")
      : deliveryOptions;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const set = <K extends keyof PlaylistItemInput>(
    key: K,
    value: PlaylistItemInput[K],
  ) => onChange({ ...itemInput(item), [key]: value });

  const handlePlayerDefaultsChange = (enabled: boolean) => {
    onChange({
      ...itemInput(item),
      usePlayerDefaults: enabled,
      durationMs:
        item.assetType === "image" && enabled
          ? undefined
          : item.assetType === "image" && !enabled
            ? (item.durationMs ?? 10_000)
            : item.durationMs,
    });
  };

  return (
    <>
      <div className="grid gap-6">
        {item.dynamic && (
          <Alert>
            <Info size={16} aria-hidden="true" />
            <AlertDescription>{t("inspector.dynamicNotice")}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertCircle size={16} aria-hidden="true" />
            <AlertTitle>{t("inspector.saveErrorTitle")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {saving && (
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Check size={13} aria-hidden="true" />
            {t("inspector.saving")}
          </div>
        )}

        <InspectorSection title={t("inspector.sections.playback")}>
          {(item.assetType === "image" || item.assetType === "video") && (
            // The wrapping label names the switch; no extra aria-label.
            <label className="flex items-start gap-2 text-sm">
              <RheaSwitch
                checked={usesPlayerDefaults}
                disabled={!editable}
                onCheckedChange={(checked) =>
                  handlePlayerDefaultsChange(checked === true)
                }
                className="mt-0.5"
              />
              <span className="grid gap-0.5">
                <strong className="font-medium">
                  {t("inspector.playerDefaults")}
                </strong>
                <small className="text-xs text-muted-foreground">
                  {t("inspector.playerDefaultsHint")}
                </small>
              </span>
            </label>
          )}
          <Field>
            <FieldLabel htmlFor="inspector-transition">
              {t("inspector.transitionLabel")}
            </FieldLabel>
            <RheaSelect
              disabled={!editable || usesPlayerDefaults}
              value={item.transition}
              onValueChange={(next) => {
                if (
                  next === "none" ||
                  next === "fade" ||
                  next === "crossfade"
                ) {
                  set("transition", next);
                }
              }}
              items={itemTransitionOptions.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
            >
              <SelectTrigger
                id="inspector-transition"
                aria-label={t("inspector.transitionAria")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {itemTransitionOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </RheaSelect>
            <FieldDescription>
              {usesPlayerDefaults
                ? t("inspector.defaultsOffHint")
                : playlistTransition !== "mixed" &&
                    item.transition !== playlistTransition
                  ? t("inspector.overridesPlaylist", {
                      transition: transitionLabel(playlistTransition, t),
                    })
                  : t("inspector.followsPlaylist")}
            </FieldDescription>
          </Field>
          {item.transition === "crossfade" && (
            <p className="text-xs text-muted-foreground">
              {t("inspector.crossfadeHint")}
            </p>
          )}
          <Field>
            <FieldLabel htmlFor="inspector-fit">
              {t("inspector.fitLabel")}
            </FieldLabel>
            <RheaSelect
              disabled={!editable || usesPlayerDefaults}
              value={item.fitMode}
              onValueChange={(next) =>
                set("fitMode", next as PlaylistItem["fitMode"])
              }
              items={fitModeOptions.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
            >
              <SelectTrigger
                id="inspector-fit"
                aria-label={t("inspector.fitAria")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fitModeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </RheaSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="inspector-delivery">
              {t("inspector.deliveryLabel")}
            </FieldLabel>
            <RheaSelect
              disabled={!editable}
              value={item.deliveryPolicy}
              onValueChange={(next) =>
                set("deliveryPolicy", next as PlaylistItem["deliveryPolicy"])
              }
              items={itemDeliveryOptions.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
            >
              <SelectTrigger
                id="inspector-delivery"
                aria-label={t("inspector.deliveryAria")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {itemDeliveryOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </RheaSelect>
          </Field>
        </InspectorSection>

        <InspectorSection title={t("inspector.sections.duration")}>
          {item.assetType === "layout" ? (
            <SecondsField
              id="layout-duration"
              label={t("inspector.layoutDuration")}
              value={item.durationMs ?? 30_000}
              disabled={!editable}
              onChange={(value) => set("durationMs", value)}
            />
          ) : item.assetType === "widget" &&
            item.widgetProvider === "youtube" ? (
            <>
              <Field>
                <FieldLabel htmlFor="inspector-widget-behavior">
                  {t("inspector.widgetBehaviorLabel")}
                </FieldLabel>
                <RheaSelect
                  disabled={!editable}
                  value={
                    item.durationMs == null ? "until_end" : "fixed_duration"
                  }
                  onValueChange={(next) =>
                    set("durationMs", next === "until_end" ? undefined : 30_000)
                  }
                  items={widgetBehaviorOptions.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey),
                  }))}
                >
                  <SelectTrigger
                    id="inspector-widget-behavior"
                    aria-label={t("inspector.widgetBehaviorAria")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {widgetBehaviorOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </RheaSelect>
              </Field>
              {item.durationMs != null && (
                <SecondsField
                  id="fixed-duration"
                  label={t("inspector.fixedDuration")}
                  value={item.durationMs}
                  disabled={!editable}
                  onChange={(value) => set("durationMs", value)}
                />
              )}
            </>
          ) : playlistItemUsesFixedDuration(item) ? (
            <SecondsField
              id="item-duration"
              label={
                item.assetType === "image"
                  ? t("inspector.imageDuration")
                  : t("inspector.durationFallback")
              }
              value={
                item.durationMs ??
                (item.assetType === "widget" ? 30_000 : 10_000)
              }
              disabled={!editable || usesPlayerDefaults}
              readOnly={item.assetType === "image" && usesPlayerDefaults}
              onChange={(value) => set("durationMs", value)}
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <SecondsField
                id="video-start"
                label={t("inspector.startLabel")}
                value={item.videoStartOffsetMs ?? 0}
                disabled={!editable || usesPlayerDefaults}
                onChange={(value) => set("videoStartOffsetMs", value)}
              />
              <SecondsField
                id="video-end"
                label={t("inspector.endLabel")}
                value={item.videoEndOffsetMs}
                disabled={!editable || usesPlayerDefaults}
                onChange={(value) => set("videoEndOffsetMs", value)}
                optional
              />
            </div>
          )}
        </InspectorSection>

        {item.assetType === "video" && (
          <InspectorSection title={t("inspector.sections.audio")}>
            {/* The wrapping label names the switch; no extra aria-label. */}
            <label className="flex items-center gap-2 text-sm">
              <RheaSwitch
                checked={item.audioEnabled}
                disabled={!editable || usesPlayerDefaults}
                onCheckedChange={(checked) =>
                  set("audioEnabled", checked === true)
                }
              />
              <span className="font-medium">{t("inspector.audioEnabled")}</span>
            </label>
            <Field>
              <FieldLabel htmlFor="inspector-volume">
                {t("inspector.volumeLabel")}
              </FieldLabel>
              <div className="flex items-center gap-3">
                <RheaSlider
                  id="inspector-volume"
                  aria-label={t("inspector.volumeAria")}
                  min={0}
                  max={1}
                  step={0.05}
                  value={[item.volume]}
                  disabled={!editable || usesPlayerDefaults}
                  onValueChange={(next) =>
                    set(
                      "volume",
                      Number(Array.isArray(next) ? (next[0] ?? 0) : next),
                    )
                  }
                  className="flex-1"
                />
                <output className="w-12 shrink-0 text-right text-sm tabular-nums">
                  {Math.round(item.volume * 100)}%
                </output>
              </div>
            </Field>
          </InspectorSection>
        )}

        {(item.availableFrom || item.expiresAt) && (
          <InspectorSection title={t("inspector.sections.availability")}>
            <dl className="grid gap-1 text-sm">
              {item.availableFrom && (
                <>
                  <dt className="text-muted-foreground">
                    {t("inspector.availableFrom")}
                  </dt>
                  <dd>
                    {new Date(item.availableFrom).toLocaleString(formatLocale)}
                  </dd>
                </>
              )}
              {item.expiresAt && (
                <>
                  <dt className="text-muted-foreground">
                    {t("inspector.expires")}
                  </dt>
                  <dd>
                    {new Date(item.expiresAt).toLocaleString(formatLocale)}
                  </dd>
                </>
              )}
            </dl>
          </InspectorSection>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {editable && (
          <RheaButton
            type="button"
            variant="destructive"
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 size={15} aria-hidden="true" />
            {t("inspector.removeItem")}
          </RheaButton>
        )}
        <RheaButton type="button" variant="outline" onClick={onClose}>
          {t("inspector.done")}
        </RheaButton>
      </div>
      <RheaAlertDialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("inspector.removeTitle", { name: item.assetName })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("inspector.removeDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmingDelete(false);
                onDelete();
              }}
            >
              {t("inspector.removeItem")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </RheaAlertDialog>
    </>
  );
}

function InspectorSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

function SecondsField({
  id,
  label,
  value,
  disabled,
  readOnly = false,
  optional = false,
  onChange,
}: {
  id: string;
  label: string;
  value?: number;
  disabled: boolean;
  readOnly?: boolean;
  optional?: boolean;
  onChange: (value: number | undefined) => void;
}) {
  const { t } = useTranslation("playlists");
  const fieldId = `inspector-seconds-${id}`;
  return (
    <Field>
      <FieldLabel htmlFor={fieldId}>
        {optional ? t("inspector.secondsOptional", { label }) : label}
      </FieldLabel>
      {readOnly ? (
        <span className="text-sm text-muted-foreground">
          {t("inspector.playerDefaultsValue")}
        </span>
      ) : (
        <InputGroup className="w-36">
          <InputGroupInput
            id={fieldId}
            aria-label={t("inspector.secondsAria", { label })}
            type="number"
            min="0"
            step="0.1"
            disabled={disabled}
            value={value == null ? "" : value / 1000}
            onChange={(event) => {
              if (!event.target.value) {
                onChange(undefined);
                return;
              }
              const seconds = Number(event.target.value);
              if (Number.isFinite(seconds) && seconds >= 0) {
                onChange(Math.round(seconds * 1000));
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            <span aria-hidden="true">{t("units.secondsShort")}</span>
          </InputGroupAddon>
        </InputGroup>
      )}
    </Field>
  );
}
