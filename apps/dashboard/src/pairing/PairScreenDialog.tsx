import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "../components/ui/drawer";
import { canManageScreens } from "../data/screens";
import { useIsMobile } from "../hooks/use-mobile";
import { PairScreenFlow } from "./PairScreenFlow";

/**
 * The browser host for pairing: a responsive dialog on desktop, a
 * near-full-height drawer on narrow screens. The flow inside is identical,
 * and the shell choice follows responsive layout, never device detection.
 */
export function PairScreenDialog() {
  const { code, requestId } = useParams();
  const { t } = useTranslation("screens");
  const auth = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const close = () => void navigate("/screens");

  const flow = (
    <PairScreenFlow
      initialCode={code}
      requestId={requestId}
      canManage={canManageScreens(auth.status?.user)}
      onClose={close}
      onOpenScreen={(screenId) => void navigate(`/screens/${screenId}`)}
    />
  );

  if (isMobile) {
    return (
      <Drawer
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
        showSwipeHandle
      >
        <DrawerContent className="max-h-[calc(100dvh-2rem)]">
          <DrawerHeader className="text-left">
            <DrawerTitle>{t("pair.title")}</DrawerTitle>
          </DrawerHeader>
          <div className="overflow-y-auto px-4 pb-4">{flow}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[min(90vh,56rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader className="pr-8">
          <DialogTitle>{t("pair.title")}</DialogTitle>
        </DialogHeader>
        {flow}
      </DialogContent>
    </Dialog>
  );
}
