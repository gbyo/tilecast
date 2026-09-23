import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
  label: string;
}[] = [
  { value: "playlist", label: "Playlist" },
  { value: "layout", label: "Layout" },
  { value: "asset", label: "Media / web" },
];

function assetDetail(asset: Asset) {
  if (asset.type === "image") return "Image";
  if (asset.type === "video") return "Video";
  return asset.widget?.provider === "youtube"
    ? "YouTube widget"
    : "Website widget";
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
  const pickerOpen = open && picker !== undefined;

  const chooseContent = (selection: QuickPresentSelection) => {
    setContentType(selection.type);
    setContentId(selection.id);
    setSelectedContent(selection);
    setPicker(undefined);
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
  const contentTypeLabel =
    contentType === "asset" ? "media or web" : contentType;
  return (
    <>
      <Dialog
        open={open && !pickerOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !pickerOpen) onClose();
        }}
      >
        <DialogContent className="max-h-[min(90vh,54rem)] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Show now</DialogTitle>
            <DialogDescription>
              Temporarily show content on <strong>{destinationName}</strong>.
              Normal content resumes when this session ends. Emergency Takeovers
              and AirPlay remain higher priority.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2 text-sm font-medium">
              <span>Content</span>
              <ToggleGroup
                aria-label="Content type"
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
                    {type.label}
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
                    onClick={() => setPicker(contentType)}
                    disabled={present.isPending}
                  >
                    Change
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPicker(contentType)}
                  disabled={present.isPending}
                >
                  Choose {contentTypeLabel}
                </Button>
              )}
            </div>
            <div className="grid gap-2 text-sm font-medium">
              <span>Duration</span>
              <Select
                items={[
                  { value: "5", label: "5 minutes" },
                  { value: "15", label: "15 minutes" },
                  { value: "30", label: "30 minutes" },
                  { value: "60", label: "1 hour" },
                  { value: "0", label: "Until stopped" },
                ]}
                value={String(durationMinutes)}
                onValueChange={(value) => {
                  if (value) {
                    setDurationMinutes(Number(value) as 0 | 5 | 15 | 30 | 60);
                  }
                }}
              >
                <SelectTrigger className="w-full" aria-label="Duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">5 minutes</SelectItem>
                  <SelectItem value="15">15 minutes</SelectItem>
                  <SelectItem value="30">30 minutes</SelectItem>
                  <SelectItem value="60">1 hour</SelectItem>
                  <SelectItem value="0">Until stopped</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={wakeDisplay}
                onCheckedChange={(checked) => setWakeDisplay(checked === true)}
              />
              Wake display if needed
            </label>
            {present.error && (
              <Alert variant="destructive">
                <AlertDescription>{present.error.message}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter className="border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={present.isPending || !contentId}
              onClick={() => present.mutate()}
            >
              {present.isPending ? "Showing…" : "Show now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {open && picker === "playlist" && (
        <PlaylistPicker
          open
          allowedKinds={["playlist"]}
          title="Choose playlist"
          description="Select a playlist from your library to show now."
          confirmLabel="Use playlist"
          selectedId={contentType === "playlist" ? contentId : ""}
          onConfirm={(choice: PlaylistPickerChoice) => {
            if (choice.kind !== "playlist") return;
            chooseContent({
              type: "playlist",
              id: choice.playlist.id,
              name: choice.playlist.name,
              detail: `${choice.playlist.itemCount} item${choice.playlist.itemCount === 1 ? "" : "s"}`,
            });
          }}
          onClose={() => setPicker(undefined)}
        />
      )}
      {open && picker === "layout" && (
        <PlaylistPicker
          open
          allowedKinds={["layout"]}
          title="Choose layout"
          description="Select a published layout from your library to show now."
          confirmLabel="Use layout"
          selectedId={contentType === "layout" ? contentId : ""}
          onConfirm={(choice: PlaylistPickerChoice) => {
            if (choice.kind !== "layout") return;
            chooseContent({
              type: "layout",
              id: choice.layout.id,
              name: choice.layout.name,
              detail: `${choice.layout.canvasWidth} × ${choice.layout.canvasHeight} · revision ${choice.layout.publishedRevision}`,
            });
          }}
          onClose={() => setPicker(undefined)}
        />
      )}
      {open && picker === "asset" && (
        <ContentPicker
          open
          mode="single"
          csrf={csrfToken}
          allowedTypes={["image", "video", "widget"]}
          selectedIds={contentType === "asset" && contentId ? [contentId] : []}
          title="Choose media or web"
          description="Select ready media or a website or app from your content library."
          confirmLabel="Use content"
          onConfirm={(items) => {
            const asset = items[0];
            if (!asset) return;
            chooseContent({
              type: "asset",
              id: asset.id,
              name: asset.name,
              detail: assetDetail(asset),
            });
          }}
          onClose={() => setPicker(undefined)}
        />
      )}
    </>
  );
}
