import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { Asset } from "../api/types";
import {
  ContentPicker,
  PlaylistPicker,
  type PlaylistPickerChoice,
} from "./content-picker";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Alert, AlertDescription } from "./ui/alert";
import { toast } from "./ui/toast";

type QuickPresentContentType = "playlist" | "layout" | "asset";

type QuickPresentSelection = {
  type: QuickPresentContentType;
  id: string;
  name: string;
  detail: string;
};

const contentTypes: readonly {
  value: QuickPresentContentType;
  labelKey:
    | "quickPresent.contentTypes.playlist"
    | "quickPresent.contentTypes.layout"
    | "quickPresent.contentTypes.asset";
}[] = [
  { value: "playlist", labelKey: "quickPresent.contentTypes.playlist" },
  { value: "layout", labelKey: "quickPresent.contentTypes.layout" },
  { value: "asset", labelKey: "quickPresent.contentTypes.asset" },
];

function assetDetail(asset: Asset, t: TFunction<"alerts">) {
  if (asset.type === "image") return t("quickPresent.assetTypes.image");
  if (asset.type === "video") return t("quickPresent.assetTypes.video");
  return asset.widget?.provider === "youtube"
    ? t("quickPresent.assetTypes.youtube")
    : t("quickPresent.assetTypes.website");
}

export function QuickPresentDialog({
  open,
  targetType,
  targetId,
  destinationName,
  csrfToken,
  onClose,
  onSuccess,
}: {
  open: boolean;
  targetType: "screen" | "group";
  targetId: string;
  destinationName: string;
  csrfToken: string;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const { t } = useTranslation(["alerts", "common"]);
  const queryClient = useQueryClient();
  const [contentType, setContentType] =
    useState<QuickPresentContentType>("playlist");
  const [contentId, setContentId] = useState("");
  const [durationMinutes, setDurationMinutes] = useState<0 | 5 | 15 | 30 | 60>(
    15,
  );
  const [wakeDisplay, setWakeDisplay] = useState(false);
  const [selectedContent, setSelectedContent] =
    useState<QuickPresentSelection>();
  const [picker, setPicker] = useState<QuickPresentContentType>();
  const [pickerOpen, setPickerOpen] = useState(false);

  const chooseContent = (selection: QuickPresentSelection) => {
    setContentType(selection.type);
    setContentId(selection.id);
    setSelectedContent(selection);
    setPickerOpen(false);
  };

  const openPicker = (type: QuickPresentContentType) => {
    setPicker(type);
    setPickerOpen(true);
  };

  const changeContentType = (type: QuickPresentContentType) => {
    setContentType(type);
    setContentId("");
    setSelectedContent(undefined);
  };
  const present = useMutation({
    mutationFn: () =>
      api.createPresentationOverride(
        {
          targetType,
          targetId,
          contentType,
          contentId,
          durationMinutes,
          afterAction: "resume",
          wakeDisplay,
        },
        csrfToken,
      ),
    onSuccess: async () => {
      toast.add({ title: "Show Now started.", type: "success" });
      await queryClient.invalidateQueries({
        queryKey: ["presentation-overrides"],
      });
      onSuccess?.();
      onClose();
    },
  });
  const selectedForType =
    selectedContent?.type === contentType ? selectedContent : undefined;
  const chooseLabel = {
    playlist: t("quickPresent.choosePlaylist"),
    layout: t("quickPresent.chooseLayout"),
    asset: t("quickPresent.chooseAsset"),
  }[contentType];
  const durationOptions = [
    { value: "5", label: t("quickPresent.durations.fiveMinutes") },
    { value: "15", label: t("quickPresent.durations.fifteenMinutes") },
    { value: "30", label: t("quickPresent.durations.thirtyMinutes") },
    { value: "60", label: t("quickPresent.durations.oneHour") },
    { value: "0", label: t("quickPresent.durations.untilStopped") },
  ];
  return (
    <>
      <Dialog
        open={open && picker === undefined}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && picker === undefined) onClose();
        }}
      >
        <DialogContent className="max-h-[min(90vh,54rem)] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("quickPresent.title")}</DialogTitle>
            <DialogDescription>
              <Trans
                i18nKey="quickPresent.description"
                ns="alerts"
                values={{ name: destinationName }}
                components={{ destination: <strong /> }}
              />
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2 text-sm font-medium">
              <span>{t("quickPresent.contentLabel")}</span>
              <ToggleGroup
                aria-label={t("quickPresent.contentTypeAria")}
                className="grid w-full grid-cols-1 gap-1 sm:grid-cols-3"
                value={[contentType]}
                onValueChange={(values) => {
                  const value = values[0];
                  if (
                    value === "playlist" ||
                    value === "layout" ||
                    value === "asset"
                  ) {
                    changeContentType(value);
                  }
                }}
                multiple={false}
                variant="outline"
                size="sm"
                spacing={1}
              >
                {contentTypes.map((type) => (
                  <ToggleGroupItem
                    key={type.value}
                    value={type.value}
                    className="min-w-0"
                  >
                    {t(type.labelKey)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {selectedForType ? (
                <div className="flex min-h-10 items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2">
                  <span className="grid min-w-0 gap-0.5">
                    <strong className="truncate text-sm">
                      {selectedForType.name}
                    </strong>
                    <small className="truncate text-xs text-muted-foreground">
                      {selectedForType.detail}
                    </small>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openPicker(contentType)}
                    disabled={present.isPending}
                  >
                    {t("quickPresent.change")}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => openPicker(contentType)}
                  disabled={present.isPending}
                >
                  {chooseLabel}
                </Button>
              )}
            </div>
            <div className="grid gap-2 text-sm font-medium">
              <span>{t("quickPresent.durationLabel")}</span>
              <Select
                items={durationOptions}
                value={String(durationMinutes)}
                onValueChange={(value) => {
                  if (value) {
                    setDurationMinutes(Number(value) as 0 | 5 | 15 | 30 | 60);
                  }
                }}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={t("quickPresent.durationLabel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {durationOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={wakeDisplay}
                onCheckedChange={(checked) => setWakeDisplay(checked === true)}
              />
              {t("quickPresent.wakeDisplay")}
            </label>
            {present.error && (
              <Alert variant="destructive">
                <AlertDescription>{present.error.message}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter className="border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={present.isPending || !contentId}
              onClick={() => present.mutate()}
            >
              {present.isPending
                ? t("quickPresent.showing")
                : t("quickPresent.showNow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {picker === "playlist" && (
        <PlaylistPicker
          open={open && pickerOpen}
          allowedKinds={["playlist"]}
          title={t("quickPresent.playlistPicker.title")}
          description={t("quickPresent.playlistPicker.description")}
          confirmLabel={t("quickPresent.playlistPicker.confirm")}
          selectedId={contentType === "playlist" ? contentId : ""}
          onConfirm={(choice: PlaylistPickerChoice) => {
            if (choice.kind !== "playlist") return;
            chooseContent({
              type: "playlist",
              id: choice.playlist.id,
              name: choice.playlist.name,
              detail: t("quickPresent.itemCount", {
                count: choice.playlist.itemCount,
              }),
            });
          }}
          onClose={() => setPickerOpen(false)}
          onCloseComplete={() => {
            if (!pickerOpen) setPicker(undefined);
          }}
        />
      )}
      {picker === "layout" && (
        <PlaylistPicker
          open={open && pickerOpen}
          allowedKinds={["layout"]}
          title={t("quickPresent.layoutPicker.title")}
          description={t("quickPresent.layoutPicker.description")}
          confirmLabel={t("quickPresent.layoutPicker.confirm")}
          selectedId={contentType === "layout" ? contentId : ""}
          onConfirm={(choice: PlaylistPickerChoice) => {
            if (choice.kind !== "layout") return;
            chooseContent({
              type: "layout",
              id: choice.layout.id,
              name: choice.layout.name,
              detail: t("quickPresent.layoutDetail", {
                width: choice.layout.canvasWidth,
                height: choice.layout.canvasHeight,
                revision: choice.layout.publishedRevision,
              }),
            });
          }}
          onClose={() => setPickerOpen(false)}
          onCloseComplete={() => {
            if (!pickerOpen) setPicker(undefined);
          }}
        />
      )}
      {picker === "asset" && (
        <ContentPicker
          open={open && pickerOpen}
          mode="single"
          csrf={csrfToken}
          allowedTypes={["image", "video", "widget"]}
          selectedIds={contentType === "asset" && contentId ? [contentId] : []}
          title={t("quickPresent.assetPicker.title")}
          description={t("quickPresent.assetPicker.description")}
          confirmLabel={t("quickPresent.assetPicker.confirm")}
          onConfirm={(items) => {
            const asset = items[0];
            if (!asset) return;
            chooseContent({
              type: "asset",
              id: asset.id,
              name: asset.name,
              detail: assetDetail(asset, t),
            });
          }}
          onClose={() => setPickerOpen(false)}
          onCloseComplete={() => {
            if (!pickerOpen) setPicker(undefined);
          }}
        />
      )}
    </>
  );
}
