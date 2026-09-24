import { AlertCircle, Info, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { PlaylistItem, PlaylistItemInput } from "../../api/types";
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
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "crossfade", label: "Crossfade" },
];

const fitModeOptions = [
  { value: "contain", label: "Contain" },
  { value: "cover", label: "Cover" },
  { value: "stretch", label: "Stretch" },
];

const deliveryOptions = [
  { value: "download", label: "Download" },
  { value: "stream", label: "Stream" },
  { value: "automatic", label: "Automatic" },
];

const widgetBehaviorOptions = [
  { value: "until_end", label: "Play until video ends" },
  { value: "fixed_duration", label: "Play for a fixed duration" },
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
            {`Item ${index + 1} · ${playlistItemTypeLabel(item)}`}
          </p>
          <DrawerTitle className="truncate">{item.assetName}</DrawerTitle>
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
        <DrawerFooter className="border-t">
          <DrawerClose render={<Button type="button" variant="outline" />}>
            Done
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
  return (
    <aside aria-label="Item inspector" className="grid content-start gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {`Item ${index + 1} · ${playlistItemTypeLabel(item)}`}
          </p>
          <h2 className="truncate text-base font-semibold tracking-tight">
            {item.assetName}
          </h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close item inspector"
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
            <AlertDescription>
              This item is generated by the playlist’s tags. Edit the tag rule
              in Playlist details to change it.
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>Could not save this item</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {item.assetStatus !== "ready" && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>
              {assetStatusLabel(item.assetStatus)} content
            </AlertTitle>
            <AlertDescription>
              Players skip this item until its media is ready.
            </AlertDescription>
          </Alert>
        )}

        <FieldSet>
          <FieldLegend variant="label">Playback</FieldLegend>
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
                    Use Player defaults
                  </FieldLabel>
                  <FieldDescription>
                    Let the assigned Player decide fit, transition, audio, and
                    volume.
                  </FieldDescription>
                </FieldContent>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="inspector-transition">Transition</FieldLabel>
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
                items={itemTransitionOptions}
              >
                <SelectTrigger
                  id="inspector-transition"
                  aria-label="Item transition"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {itemTransitionOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {usesPlayerDefaults
                  ? "Turn off Player defaults to set an item override."
                  : playlistTransition !== "mixed" &&
                      item.transition !== playlistTransition
                    ? `Overrides playlist: ${transitionLabel(playlistTransition)}`
                    : item.transition === "crossfade"
                      ? "Visuals blend. Audio changes at the item boundary."
                      : "This item follows the playlist transition."}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="inspector-fit">Fit</FieldLabel>
              <Select
                disabled={!editable || usesPlayerDefaults}
                value={item.fitMode}
                onValueChange={(next) =>
                  set("fitMode", next as PlaylistItem["fitMode"])
                }
                items={fitModeOptions}
              >
                <SelectTrigger id="inspector-fit" aria-label="Item fit mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fitModeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="inspector-delivery">Delivery</FieldLabel>
              <Select
                disabled={!editable}
                value={item.deliveryPolicy}
                onValueChange={(next) =>
                  set("deliveryPolicy", next as PlaylistItem["deliveryPolicy"])
                }
                items={itemDeliveryOptions}
              >
                <SelectTrigger
                  id="inspector-delivery"
                  aria-label="Item delivery policy"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {itemDeliveryOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <FieldLegend variant="label">Duration</FieldLegend>
          <FieldGroup className="gap-4">
            {item.assetType === "layout" ? (
              <SecondsField
                label="Layout duration"
                value={item.durationMs ?? 30_000}
                disabled={!editable}
                onChange={(value) => set("durationMs", value)}
              />
            ) : item.assetType === "widget" &&
              item.widgetProvider === "youtube" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="inspector-widget-behavior">
                    Playback behavior
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
                    items={widgetBehaviorOptions}
                  >
                    <SelectTrigger
                      id="inspector-widget-behavior"
                      aria-label="Widget playback behavior"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {widgetBehaviorOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {item.durationMs != null && (
                  <SecondsField
                    label="Fixed duration"
                    value={item.durationMs}
                    disabled={!editable}
                    onChange={(value) => set("durationMs", value)}
                  />
                )}
              </>
            ) : playlistItemUsesFixedDuration(item) ? (
              <SecondsField
                label={
                  item.assetType === "image" ? "Image duration" : "Duration"
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
                  label="Start"
                  value={item.videoStartOffsetMs ?? 0}
                  disabled={!editable || usesPlayerDefaults}
                  onChange={(value) => set("videoStartOffsetMs", value)}
                />
                <SecondsField
                  label="End"
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
              <FieldLegend variant="label">Audio</FieldLegend>
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
                    Audio enabled
                  </FieldLabel>
                </Field>
                <Field>
                  <FieldLabel htmlFor="inspector-volume">Volume</FieldLabel>
                  <div className="flex items-center gap-3">
                    <Slider
                      id="inspector-volume"
                      aria-label="Item volume"
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
              <FieldLegend variant="label">Availability</FieldLegend>
              <dl className="grid gap-1 text-sm">
                {item.availableFrom && (
                  <>
                    <dt className="text-muted-foreground">Available from</dt>
                    <dd>{new Date(item.availableFrom).toLocaleString()}</dd>
                  </>
                )}
                {item.expiresAt && (
                  <>
                    <dt className="text-muted-foreground">Expires</dt>
                    <dd>{new Date(item.expiresAt).toLocaleString()}</dd>
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
                  Remove item
                </Button>
              )}
              <span
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                {saving && (
                  <>
                    <Spinner aria-hidden="true" />
                    Saving…
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
              Remove {item.assetName} from this playlist?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The item leaves the timeline but its media stays in the library.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmingDelete(false);
                onDelete();
              }}
            >
              Remove item
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SecondsField({
  label,
  value,
  disabled,
  readOnly = false,
  optional = false,
  onChange,
}: {
  label: string;
  value?: number;
  disabled: boolean;
  readOnly?: boolean;
  optional?: boolean;
  onChange: (value: number | undefined) => void;
}) {
  const fieldId = `inspector-seconds-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <Field>
      <FieldLabel htmlFor={fieldId}>
        {label}
        {optional ? " (optional)" : ""}
      </FieldLabel>
      {readOnly ? (
        <span className="text-sm text-muted-foreground">Player defaults</span>
      ) : (
        <InputGroup className="w-32">
          <InputGroupInput
            id={fieldId}
            aria-label={`${label} in seconds`}
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
            <InputGroupText aria-hidden="true">s</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
      )}
    </Field>
  );
}
