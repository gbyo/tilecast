import { useRef, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "../../components/ui/drawer";
import { useCompactLayout } from "../../hooks/use-compact-layout";

/**
 * A dialog on wide viewports and a bottom drawer on phones, with one shape in
 * both: a header, a body that scrolls, and a footer that stays in view. The
 * choice follows viewport width, never device detection, and only one of the
 * two ever mounts, so the body's controls exist once.
 */
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  const compact = useCompactLayout();
  // The body scrolls, so it is also where focus starts: landing on the first
  // control inside it would scroll the body past the top of the review. It is
  // focusable so a keyboard can scroll it.
  const bodyRef = useRef<HTMLDivElement>(null);

  if (compact) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
        <DrawerContent
          className="max-h-[calc(100dvh-2rem)]"
          initialFocus={bodyRef}
        >
          <DrawerHeader className="text-left">
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription>{description}</DrawerDescription>
          </DrawerHeader>
          <div
            ref={bodyRef}
            tabIndex={0}
            role="region"
            aria-label={title}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
          >
            {children}
          </div>
          <DrawerFooter className="flex-col-reverse border-t pt-4">
            {footer}
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[min(90dvh,48rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-2xl"
        initialFocus={bodyRef}
      >
        <DialogHeader className="px-6 pt-6 pr-14 pb-4">
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div
          ref={bodyRef}
          tabIndex={0}
          role="region"
          aria-label={title}
          className="overflow-y-auto border-y px-6 py-5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          {children}
        </div>
        <DialogFooter className="px-6 py-4">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
