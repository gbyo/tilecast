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
import { canPairScreens } from "../data/screens";
import { usePhoneLayout } from "../hooks/use-phone-layout";
import { PairScreenFlow } from "./PairScreenFlow";

/**
 * The browser host for pairing: a dialog on iPad/desktop widths and a
 * near-full-height Drawer only on phone-sized content. The flow is identical,
 * and the choice follows available width rather than device detection.
 */
export function PairScreenDialog() {
  const { code, requestId } = useParams();
  const { t } = useTranslation("screens");
  const auth = useAuth();
  const navigate = useNavigate();
  const phone = usePhoneLayout();
  const close = () => void navigate("/screens");

  const flow = (
    <PairScreenFlow
      initialCode={code}
      requestId={requestId}
      canManage={canPairScreens(auth.status)}
      onClose={close}
      onOpenScreen={(screenId) => void navigate(`/screens/${screenId}`)}
    />
  );

  if (phone) {
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
