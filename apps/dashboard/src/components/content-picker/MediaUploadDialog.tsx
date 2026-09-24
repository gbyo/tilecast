import { useCallback, useRef } from "react";
import type { Asset } from "../../api/types";
import { useConfirm } from "../ConfirmDialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { MediaUploadPanel } from "./MediaUploadPanel";

// useUploadCloseGuard asks before a surface holding the upload panel closes
// while a file is still transferring, so closing never silently abandons it.
export function useUploadCloseGuard() {
  // A ref, not state: the close request must see the panel's latest report
  // even when it arrives before this component re-renders.
  const active = useRef(false);
  const setActive = useCallback((value: boolean) => {
    active.current = value;
  }, []);
  const { confirm, dialog } = useConfirm();
  const guard = (close: () => void) => {
    if (!active.current) {
      close();
      return;
    }
    void confirm({
      title: "Uploads are still active. Close this upload view?",
      body: "Transfers keep running in the background, but this view stops showing their progress.",
      action: "Close",
    }).then((ok) => {
      if (ok) close();
    });
  };
  return { setActive, guard, dialog };
}

/** The standalone upload surface launched from the global command palette. */
export function MediaUploadDialog({
  open,
  csrf,
  onAsset,
  onClose,
}: {
  open: boolean;
  csrf: string;
  onAsset?: (asset: Asset) => void;
  onClose: () => void;
}) {
  const { setActive, guard, dialog } = useUploadCloseGuard();
  return (
    <>
      {dialog}
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) guard(onClose);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Upload media</DialogTitle>
            <DialogDescription>
              Uploaded images and videos land in the media library once
              processing finishes.
            </DialogDescription>
          </DialogHeader>
          <MediaUploadPanel
            csrf={csrf}
            onAsset={onAsset}
            onActiveChange={setActive}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => guard(onClose)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
