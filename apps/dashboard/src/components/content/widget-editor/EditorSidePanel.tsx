import type { ReactNode } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useCompactLayout } from "@/hooks/use-compact-layout";

/**
 * A secondary editor surface: a Sheet beside the editor on wide screens, a
 * Drawer on compact ones. Exactly one is mounted, so its controls never
 * appear twice to assistive technology.
 */
export function EditorSidePanel({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const compact = useCompactLayout();
  if (compact)
    return (
      <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
        <DrawerContent className="max-h-[calc(100dvh-2rem)]">
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
            {description && (
              <DrawerDescription>{description}</DrawerDescription>
            )}
          </DrawerHeader>
          <div className="min-h-0 overflow-y-auto px-4 pb-6">{children}</div>
        </DrawerContent>
      </Drawer>
    );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}
