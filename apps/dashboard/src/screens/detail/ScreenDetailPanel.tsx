import type { ReactNode } from "react";
import { useDesktopLayout } from "../../hooks/use-desktop-layout";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "../../components/ui/drawer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";

/**
 * Responsive secondary detail surface for Screen detail: a right-side Sheet
 * on desktop, the Base UI Drawer on narrow/mobile viewports. Opening and
 * closing is owned by the caller's Back-able URL state.
 */
export function ScreenDetailPanel({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  const desktop = useDesktopLayout();
  const header = desktop ? (
    <SheetHeader className="border-b border-border">
      <SheetTitle>{title}</SheetTitle>
      <SheetDescription>{description}</SheetDescription>
    </SheetHeader>
  ) : (
    <DrawerHeader className="text-left">
      <DrawerTitle>{title}</DrawerTitle>
      <DrawerDescription>{description}</DrawerDescription>
    </DrawerHeader>
  );
  const body = (
    <div
      className={
        desktop
          ? "min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6"
          : "min-h-0 flex-1 overflow-y-auto px-4 pb-6"
      }
    >
      {children}
    </div>
  );

  return desktop ? (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-4 overflow-hidden sm:max-w-2xl"
      >
        {header}
        {body}
      </SheetContent>
    </Sheet>
  ) : (
    <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
      <DrawerContent className="max-h-[calc(100dvh-2rem)]">
        {header}
        {body}
      </DrawerContent>
    </Drawer>
  );
}
