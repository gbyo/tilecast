import type { ReactNode } from "react";
import { useDesktopLayout } from "../../hooks/use-desktop-layout";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "../../components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
} from "../../components/ui/drawer";

export function UpdateSurface({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  presentation = "sheet",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  presentation?: "sheet" | "dialog";
}) {
  const desktop = useDesktopLayout();
  const body = (
    <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-4 pb-4 sm:px-6">
      {children}
    </div>
  );

  if (!desktop) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
        <DrawerContent className="flex max-h-[calc(100dvh-1rem)] flex-col">
          <DrawerHeader className="shrink-0 text-left">
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription>{description}</DrawerDescription>
          </DrawerHeader>
          {body}
          {footer && (
            <DrawerFooter className="shrink-0 border-t bg-background">
              {footer}
            </DrawerFooter>
          )}
        </DrawerContent>
      </Drawer>
    );
  }

  if (presentation === "dialog") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[min(860px,calc(100dvh-3rem))] max-w-4xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
            <DialogTitle className="text-lg">{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {body}
          {footer && (
            <DialogFooter className="shrink-0 border-t bg-background px-6 py-4">
              {footer}
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 sm:max-w-2xl">
        <SheetHeader className="shrink-0">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {body}
        {footer && (
          <SheetFooter className="shrink-0 border-t bg-background">
            {footer}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
