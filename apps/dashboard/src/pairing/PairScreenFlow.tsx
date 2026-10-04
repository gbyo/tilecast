import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, QrCode } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { PairingRequest, Screen } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useConfirm } from "../components/ConfirmDialog";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Separator } from "../components/ui/separator";
import { toast } from "../components/ui/toast";
import { screenKeys, screenQueries } from "../data/screens";
import { apiErrorMessage } from "../i18n";
import { useNativeHaptic } from "../native-host/useNativeSystem";
import {
  useNativeQrScanner,
  useNativeQrScannerAvailable,
} from "../native-host/useNativeQrScanner";
import { PairingCodeInput, filterPairingCodeInput } from "./PairingCodeInput";
import {
  PairingDestination,
  type PairingOperation,
} from "./PairingDestination";
import { makeApprovalSchema, PairingDetailsForm } from "./PairingDetailsForm";
import { PairingPlayerReview } from "./PairingPlayerReview";
import {
  defaultPairingDestination,
  deviceLabel,
  hardwareApprovalInput,
  pairingApprovalLabel,
  pairingApprovalPayload,
  repairApprovalInput,
  resolvePairingErrorMessage,
  type ApprovalForm,
} from "./pairingFlow";
import { normalizePairingCode, parsePairingQr } from "./pairingQr";

/** Focuses a stage heading once, when its stage mounts. */
function StageHeading({ children }: { children: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h2
      ref={ref}
      tabIndex={-1}
      className="text-lg font-semibold tracking-tight outline-none"
    >
      {children}
    </h2>
  );
}

function PairingReviewStage({
  request,
  csrfToken,
  onPaired,
  onClose,
}: {
  request: PairingRequest;
  csrfToken: string;
  onPaired: (screen: Screen) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const queryClient = useQueryClient();
  const haptic = useNativeHaptic();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [destination, setDestination] = useState<PairingOperation>(() =>
    defaultPairingDestination(request),
  );
  const [replacementScreenId, setReplacementScreenId] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const form = useForm<ApprovalForm>({
    resolver: zodResolver(useMemo(() => makeApprovalSchema(t), [t])),
    defaultValues: {
      name: request.existingScreenName ?? deviceLabel(request),
      locationId: undefined,
      roomName: "",
      roomNumber: "",
      description: "",
    },
  });
  const locations = useQuery({
    queryKey: ["locations"],
    queryFn: api.locations,
  });
  const replacementOptions = useQuery({
    ...screenQueries.replacementOptions(),
    enabled: destination === "replace_hardware",
  });
  const approve = useMutation({
    mutationFn: (values: ApprovalForm) =>
      api.approvePairing(
        request.id,
        pairingApprovalPayload(
          request,
          values,
          destination,
          replacementScreenId,
        ),
        csrfToken,
      ),
    onSuccess: async (screen) => {
      await queryClient.invalidateQueries({ queryKey: screenKeys.all });
      await queryClient.invalidateQueries({
        queryKey: screenKeys.pendingPairings(),
      });
      haptic("success");
      onPaired(screen);
    },
    onError: (error) => setApprovalError(apiErrorMessage(error)),
  });
  const reject = useMutation({
    mutationFn: () =>
      api.rejectPairing(request.id, "Rejected by administrator", csrfToken),
    onSuccess: () => {
      toast.add({ title: t("pair.rejected"), type: "success" });
      onClose();
    },
    onError: (error) => setApprovalError(apiErrorMessage(error)),
  });

  const submitNewScreen = (values: ApprovalForm) => {
    setApprovalError("");
    approve.mutate(values);
  };
  const submitRepair = async () => {
    setApprovalError("");
    const name = request.existingScreenName ?? deviceLabel(request);
    const confirmed = await confirm({
      title: t("approval.repairTitle", { name }),
      body: t("approval.repairBody"),
      action: t("approval.actionRepair"),
    });
    if (confirmed) approve.mutate(repairApprovalInput(request));
  };
  const submitReplacement = async () => {
    setApprovalError("");
    const target = (replacementOptions.data?.items ?? []).find(
      (screen) => screen.id === replacementScreenId,
    );
    if (!target) {
      setApprovalError(t("approval.chooseScreenError"));
      return;
    }
    const confirmed = await confirm({
      title: t("approval.replaceTitle", { name: target.name }),
      body: t("approval.replaceBody"),
      action: t("approval.actionReplace"),
    });
    if (confirmed) approve.mutate(hardwareApprovalInput());
  };

  const busy = approve.isPending || reject.isPending;
  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        type="button"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        onClick={() => reject.mutate()}
        disabled={busy}
      >
        {t("approval.reject")}
      </Button>
      {destination === "new_screen" ? (
        <Button type="submit" disabled={busy}>
          {approve.isPending
            ? t("approval.approving")
            : pairingApprovalLabel(request, t, destination)}
        </Button>
      ) : (
        <Button
          type="button"
          disabled={busy}
          onClick={() =>
            void (destination === "credential_repair"
              ? submitRepair()
              : submitReplacement())
          }
        >
          {approve.isPending
            ? t("approval.approving")
            : pairingApprovalLabel(request, t, destination)}
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("approval.step")}
        </p>
        <StageHeading>{t("approval.title")}</StageHeading>
        <p className="text-sm text-muted-foreground">{t("approval.body")}</p>
      </div>
      <PairingPlayerReview request={request} />
      <PairingDestination
        request={request}
        destination={destination}
        onChange={(next) => {
          setApprovalError("");
          setDestination(next);
        }}
        replacementScreenId={replacementScreenId}
        onReplacementScreenChange={setReplacementScreenId}
      />
      {approvalError && (
        <Alert variant="destructive">
          <AlertDescription>{approvalError}</AlertDescription>
        </Alert>
      )}
      {destination === "new_screen" ? (
        <form
          className="grid gap-4"
          onSubmit={(event) => void form.handleSubmit(submitNewScreen)(event)}
        >
          <PairingDetailsForm
            form={form}
            locations={locations.data?.items ?? []}
          />
          {actions}
        </form>
      ) : (
        actions
      )}
      {confirmDialog}
    </div>
  );
}

function PairingSuccessStage({
  screen,
  onOpenScreen,
  onClose,
}: {
  screen: Screen;
  onOpenScreen: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("screens");
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <CircleCheck
          aria-hidden="true"
          className="mt-0.5 size-6 shrink-0 text-emerald-700 dark:text-emerald-400"
        />
        <div className="space-y-1.5">
          <StageHeading>
            {t("success.title", { name: screen.name })}
          </StageHeading>
          <p className="text-sm text-muted-foreground">{t("success.body")}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          {t("success.done")}
        </Button>
        <Button type="button" onClick={onOpenScreen}>
          {t("success.openScreen")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The reusable pair-screen workflow. It owns the domain state and renders
 * stage content; the host — browser dialog, drawer, or native presentation —
 * owns the shell and closes or navigates through callbacks.
 */
export function PairScreenFlow({
  initialCode,
  requestId,
  canManage,
  onClose,
  onOpenScreen,
}: {
  initialCode?: string;
  requestId?: string;
  canManage: boolean;
  onClose: () => void;
  onOpenScreen: (screenId: string) => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const auth = useAuth();
  const [request, setRequest] = useState<PairingRequest>();
  const [paired, setPaired] = useState<Screen>();
  const [code, setCode] = useState(() =>
    filterPairingCodeInput(initialCode ?? ""),
  );
  const [codeError, setCodeError] = useState<string>();
  const [resolving, setResolving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const scannerAvailable = useNativeQrScannerAvailable();
  const scanQr = useNativeQrScanner();
  const identity = useQuery({
    queryKey: ["systemIdentity"],
    queryFn: api.systemIdentity,
    enabled: scannerAvailable,
  });

  const lookup = async (raw: string) => {
    const normalized = normalizePairingCode(raw);
    if (!normalized) {
      setCodeError(
        raw.trim() === "" ? t("pair.codeRequired") : t("pair.invalidFormat"),
      );
      return;
    }
    setCodeError(undefined);
    setResolving(true);
    try {
      setRequest(await api.resolvePairing(normalized));
    } catch (error) {
      setCodeError(resolvePairingErrorMessage(error, t));
    } finally {
      setResolving(false);
    }
  };

  const scan = async () => {
    setScanning(true);
    try {
      const result = await scanQr();
      if (!result || result.outcome !== "scanned" || !result.value) return;
      const installationId = identity.data?.installationId;
      if (!installationId) {
        setCodeError(t("pair.resolveError"));
        return;
      }
      const parsed = parsePairingQr(result.value, {
        origin: window.location.origin,
        installationId,
      });
      if (!parsed.ok) {
        setCodeError(
          parsed.reason === "wrong_installation"
            ? t("qr.wrongInstallation")
            : parsed.reason === "wrong_server"
              ? t("qr.wrongServer")
              : t("qr.invalid"),
        );
        return;
      }
      setCode(parsed.code);
      await lookup(parsed.code);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    if (initialCode && !request) void lookup(initialCode);
  }, [initialCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = useQuery({
    ...screenQueries.pendingPairings(),
    enabled: Boolean(requestId),
  });
  useEffect(() => {
    if (!requestId || !pending.data) return;
    const found = pending.data.items.find((item) => item.id === requestId);
    if (found) setRequest(found);
    else setCodeError(t("pair.notFound"));
  }, [requestId, pending.data, t]);

  if (!canManage) {
    return (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <StageHeading>{t("pair.gateTitle")}</StageHeading>
          <p className="text-sm text-muted-foreground">{t("pair.gateBody")}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("pair.backToScreens")}
          </Button>
        </div>
      </div>
    );
  }

  if (paired) {
    return (
      <PairingSuccessStage
        screen={paired}
        onOpenScreen={() => onOpenScreen(paired.id)}
        onClose={onClose}
      />
    );
  }

  if (request) {
    return (
      <PairingReviewStage
        key={request.id}
        request={request}
        csrfToken={auth.status?.csrfToken ?? ""}
        onPaired={setPaired}
        onClose={onClose}
      />
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void lookup(code);
      }}
    >
      {scannerAvailable ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("qr.scanHint")}</p>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={scanning || identity.isLoading}
            onClick={() => void scan()}
          >
            <QrCode aria-hidden="true" /> {t("qr.scan")}
          </Button>
          <div className="flex items-center gap-3" aria-hidden="true">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">{t("qr.or")}</span>
            <Separator className="flex-1" />
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("pair.body")}</p>
      )}
      <PairingCodeInput
        value={code}
        onChange={setCode}
        error={codeError}
        autoFocus
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          {t("common:actions.cancel")}
        </Button>
        <Button type="submit" disabled={resolving}>
          {t("pair.findPlayer")}
        </Button>
      </div>
    </form>
  );
}
