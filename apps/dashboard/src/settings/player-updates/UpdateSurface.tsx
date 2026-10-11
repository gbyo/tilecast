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
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
} from "../../components/ui/drawer";

// One body and footer, arranged in the existing Studio desktop/mobile overlays.
export function UpdateSurface({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const desktop = useDesktopLayout();
  const body = (
    <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4 pb-4 sm:px-6">
      {children}
    </div>
  );
  return desktop ? (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={wide ? "flex w-full flex-col gap-4 sm:max-w-3xl" : "flex w-full flex-col gap-4 sm:max-w-2xl"}
      >
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
  ) : (
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
