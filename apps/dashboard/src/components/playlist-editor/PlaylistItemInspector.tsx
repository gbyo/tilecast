import { AlertCircle, Info, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlaylistItem, PlaylistItemInput } from "../../api/types";
import { useFormatLocale } from "../../i18n";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "../ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "../ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "../ui/drawer";
import { Slider } from "../ui/slider";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import {
  assetStatusLabel,
  itemInput,
  playlistItemTypeLabel,
  playlistItemUsesFixedDuration,
  transitionLabel,
} from "./playlistEditorModel";

const itemTransitionOptions = [
  { value: "none", labelKey: "inspector.transitionOptions.none" },
  { value: "fade", labelKey: "inspector.transitionOptions.fade" },
  { value: "crossfade", labelKey: "inspector.transitionOptions.crossfade" },
] as const;

const fitModeOptions = [
  { value: "contain", labelKey: "inspector.fitOptions.contain" },
  { value: "cover", labelKey: "inspector.fitOptions.cover" },
  { value: "stretch", labelKey: "inspector.fitOptions.stretch" },
] as const;

const deliveryOptions = [
  { value: "download", labelKey: "inspector.deliveryOptions.download" },
  { value: "stream", labelKey: "inspector.deliveryOptions.stream" },
  { value: "automatic", labelKey: "inspector.deliveryOptions.automatic" },
] as const;

const widgetBehaviorOptions = [
  { value: "until_end", labelKey: "inspector.widgetBehavior.untilEnd" },
  {
    value: "fixed_duration",
    labelKey: "inspector.widgetBehavior.fixedDuration",
  },
] as const;

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
              type: playlistItemTypeLabel(item, t),
            })}
          </p>
          <DrawerTitle className="truncate">{item.assetName}</DrawerTitle>
          <DrawerDescription className="sr-only">
            {t("inspector.drawerDescription")}
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
        <DrawerFooter className="border-t">
          <DrawerClose render={<Button type="button" variant="outline" />}>
            {t("inspector.done")}
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

// PlaylistItemInspectorPane is the desktop inline inspector: it exists only
// while an item is selected, so the timeline keeps the full width otherwise.
export function PlaylistItemInspectorPane(props: InspectorProps) {
  const { item, index, onClose } = props;
  const { t } = useTranslation("playlists");
  return (
    <aside
      aria-label={t("editor.itemInspectorLabel")}
      className="grid content-start gap-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("inspector.itemHeading", {
              index: index + 1,
              type: playlistItemTypeLabel(item, t),
            })}
          </p>
          <h2 className="truncate text-base font-semibold tracking-tight">
            {item.assetName}
          </h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("inspector.close")}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <PlaylistItemInspectorBody {...props} />
    </aside>
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
      <FieldGroup className="gap-6">
        {item.dynamic && (
          <Alert>
            <Info aria-hidden="true" />
            <AlertDescription>{t("inspector.dynamicNotice")}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>{t("inspector.saveErrorTitle")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {item.assetStatus !== "ready" && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>
              {t("inspector.notReadyTitle", {
                status: assetStatusLabel(item.assetStatus, t),
              })}
            </AlertTitle>
            <AlertDescription>
              {t("inspector.notReadyDescription")}
            </AlertDescription>
          </Alert>
        )}

        <FieldSet>
          <FieldLegend variant="label">
            {t("inspector.sections.playback")}
          </FieldLegend>
          <FieldGroup className="gap-4">
            {(item.assetType === "image" || item.assetType === "video") && (
              <Field orientation="horizontal">
                <Switch
                  id="inspector-player-defaults"
                  checked={usesPlayerDefaults}
                  disabled={!editable}
                  onCheckedChange={(checked) =>
                    handlePlayerDefaultsChange(checked === true)
                  }
                />
                <FieldContent>
                  <FieldLabel htmlFor="inspector-player-defaults">
                    {t("inspector.playerDefaults")}
                  </FieldLabel>
                  <FieldDescription>
                    {t("inspector.playerDefaultsHint")}
                  </FieldDescription>
                </FieldContent>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="inspector-transition">
                {t("inspector.transitionLabel")}
              </FieldLabel>
              <Select
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
              </Select>
              <FieldDescription>
                {usesPlayerDefaults
                  ? t("inspector.defaultsOffHint")
                  : playlistTransition !== "mixed" &&
                      item.transition !== playlistTransition
                    ? t("inspector.overridesPlaylist", {
                        transition: transitionLabel(playlistTransition, t),
                      })
                    : item.transition === "crossfade"
                      ? t("inspector.crossfadeShortHint")
                      : t("inspector.followsPlaylist")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="inspector-fit">
                {t("inspector.fitLabel")}
              </FieldLabel>
              <Select
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
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="inspector-delivery">
                {t("inspector.deliveryLabel")}
              </FieldLabel>
              <Select
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
              </Select>
            </Field>
          </FieldGroup>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <FieldLegend variant="label">
            {t("inspector.sections.duration")}
          </FieldLegend>
          <FieldGroup className="gap-4">
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
                  <Select
                    disabled={!editable}
                    value={
                      item.durationMs == null ? "until_end" : "fixed_duration"
                    }
                    onValueChange={(next) =>
                      set(
                        "durationMs",
                        next === "until_end" ? undefined : 30_000,
                      )
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
                  </Select>
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
                id={item.assetType === "image" ? "image-duration" : "duration"}
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
              <div className="grid grid-cols-2 gap-4">
                <SecondsField
                  id="start"
                  label={t("inspector.startLabel")}
                  value={item.videoStartOffsetMs ?? 0}
                  disabled={!editable || usesPlayerDefaults}
                  onChange={(value) => set("videoStartOffsetMs", value)}
                />
                <SecondsField
                  id="end"
                  label={t("inspector.endLabel")}
                  value={item.videoEndOffsetMs}
                  disabled={!editable || usesPlayerDefaults}
                  onChange={(value) => set("videoEndOffsetMs", value)}
                  optional
                />
              </div>
            )}
          </FieldGroup>
        </FieldSet>

        {item.assetType === "video" && (
          <>
            <FieldSeparator />
            <FieldSet>
              <FieldLegend variant="label">
                {t("inspector.sections.audio")}
              </FieldLegend>
              <FieldGroup className="gap-4">
                <Field orientation="horizontal">
                  <Switch
                    id="inspector-audio"
                    checked={item.audioEnabled}
                    disabled={!editable || usesPlayerDefaults}
                    onCheckedChange={(checked) =>
                      set("audioEnabled", checked === true)
                    }
                  />
                  <FieldLabel htmlFor="inspector-audio">
                    {t("inspector.audioEnabled")}
                  </FieldLabel>
                </Field>
                <Field>
                  <FieldLabel htmlFor="inspector-volume">
                    {t("inspector.volumeLabel")}
                  </FieldLabel>
                  <div className="flex items-center gap-3">
                    <Slider
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
              </FieldGroup>
            </FieldSet>
          </>
        )}

        {(item.availableFrom || item.expiresAt) && (
          <>
            <FieldSeparator />
            <FieldSet>
              <FieldLegend variant="label">
                {t("inspector.sections.availability")}
              </FieldLegend>
              <dl className="grid gap-1 text-sm">
                {item.availableFrom && (
                  <>
                    <dt className="text-muted-foreground">
                      {t("inspector.availableFrom")}
                    </dt>
                    <dd>
                      {new Date(item.availableFrom).toLocaleString(
                        formatLocale,
                      )}
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
            </FieldSet>
          </>
        )}

        {(editable || saving) && (
          <>
            <FieldSeparator />
            <div className="flex items-center justify-between gap-3">
              {editable && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 aria-hidden="true" />
                  {t("inspector.removeItem")}
                </Button>
              )}
              <span
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                {saving && (
                  <>
                    <Spinner aria-hidden="true" />
                    {t("common:actions.saving")}
                  </>
                )}
              </span>
            </div>
          </>
        )}
      </FieldGroup>
      <AlertDialog
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
              variant="destructive"
              onClick={() => {
                setConfirmingDelete(false);
                onDelete();
              }}
            >
              {t("inspector.removeItem")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
        <InputGroup className="w-32">
          <InputGroupInput
            id={fieldId}
            aria-label={t("inspector.secondsAria", { label })}
            type="number"
            inputMode="decimal"
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
            <InputGroupText aria-hidden="true">
              {t("units.secondsShort")}
            </InputGroupText>
          </InputGroupAddon>
        </InputGroup>
      )}
    </Field>
  );
}
