import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LockKeyhole, Pencil, Plus, Trash2, Wifi } from "lucide-react";
import { api } from "../api/client";
import type {
  PresentationNetwork,
  PresentationNetworkInput,
  Screen,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useConfirm } from "../components/ConfirmDialog";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button as RheaButton } from "../components/ui/button";
import { Checkbox as RheaCheckbox } from "../components/ui/checkbox";
import {
  Dialog as RheaDialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";

type NetworkDraft = Omit<PresentationNetworkInput, "secret"> & {
  identity: string;
  anonymousIdentity: string;
  caCertificatePem: string;
  domainSuffixMatch: string;
};

const emptyDraft: NetworkDraft = {
  name: "",
  ssid: "",
  hidden: false,
  security: "wpa_psk",
  identity: "",
  anonymousIdentity: "",
  caCertificatePem: "",
  domainSuffixMatch: "",
};

function isLinux(screen: Screen) {
  return screen.platform.trim().toLowerCase() === "linux";
}

function safeError(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function securityLabel(
  options: { value: string; label: string }[] | undefined,
  value: string,
) {
  return options?.find((option) => option.value === value)?.label ?? value;
}

export function PresentationNetworksPanel({
  canManage,
}: {
  canManage: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const auth = useAuth();
  const client = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const { confirm, dialog: confirmDialog } = useConfirm();
  const networks = useQuery({
    queryKey: ["presentation-networks"],
    queryFn: api.presentationNetworks,
    enabled: canManage,
  });
  const screens = useQuery({
    queryKey: ["screens", "presentation-network-assignment-picker"],
    queryFn: api.screens,
    enabled: canManage,
  });
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState<NetworkDraft>(emptyDraft);
  // Keep this separate from the draft and from all query data. It is write-only
  // and is never rehydrated from a GET response.
  const [secret, setSecret] = useState("");
  const [assignmentIds, setAssignmentIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<string>();

  const detail = useQuery({
    queryKey: ["presentation-network", editing],
    queryFn: () => api.presentationNetwork(editing as string),
    enabled: Boolean(editing && editing !== "new"),
  });

  const linuxScreens = useMemo(
    () => (screens.data?.items ?? []).filter(isLinux),
    [screens.data],
  );

  useEffect(() => {
    if (editing === "new") {
      setDraft({ ...emptyDraft });
      setSecret("");
      setAssignmentIds([]);
      return;
    }
    if (!editing || detail.data?.network.id !== editing) return;
    const network = detail.data.network;
    setDraft({
      name: network.name,
      ssid: network.ssid,
      hidden: network.hidden,
      security: network.security,
      identity: network.auth.identity ?? "",
      anonymousIdentity: network.auth.anonymousIdentity ?? "",
      caCertificatePem: network.auth.caCertificatePem ?? "",
      domainSuffixMatch: network.auth.domainSuffixMatch ?? "",
    });
    // Secret intentionally remains blank, even when credentialSet is true.
    setSecret("");
    setAssignmentIds(
      detail.data.assignments.map((assignment) => assignment.screenId),
    );
  }, [detail.data, editing]);

  const save = useMutation({
    mutationFn: async () => {
      const input: PresentationNetworkInput = {
        ...draft,
        ...(secret.length > 0 ? { secret } : {}),
      };
      const network =
        editing === "new"
          ? await api.createPresentationNetwork(input, csrf)
          : await api.updatePresentationNetwork(editing ?? "", input, csrf);
      await api.replacePresentationNetworkAssignments(
        network.id,
        assignmentIds,
        csrf,
      );
      return network;
    },
    onSuccess: async () => {
      setEditing(undefined);
      setSecret("");
      setNotice(t("networks.saved"));
      await client.invalidateQueries({ queryKey: ["presentation-networks"] });
      await client.invalidateQueries({ queryKey: ["presentation-network"] });
      await client.invalidateQueries({ queryKey: ["screens"] });
    },
  });

  const remove = useMutation({
    mutationFn: (network: PresentationNetwork) =>
      api.deletePresentationNetwork(network.id, csrf),
    onSuccess: async () => {
      setNotice(t("networks.deleted"));
      await client.invalidateQueries({ queryKey: ["presentation-networks"] });
      await client.invalidateQueries({ queryKey: ["screens"] });
    },
  });

  const open = (network: PresentationNetwork | "new") => {
    setNotice(undefined);
    setSaveError(undefined);
    setEditing(network === "new" ? "new" : network.id);
    if (network === "new") {
      setDraft({ ...emptyDraft });
      setSecret("");
      setAssignmentIds([]);
    }
  };

  // A local error keeps a failed save visible after the dialog is reopened,
  // without copying any input value into an alert or toast.
  const [saveError, setSaveError] = useState<string>();
  useEffect(() => {
    if (save.error)
      setSaveError(safeError(save.error, t("networks.saveError")));
  }, [save.error, t]);

  if (!canManage)
    return (
      <Alert role="status">
        <AlertDescription>{t("networks.manageOnly")}</AlertDescription>
      </Alert>
    );

  const unavailable = networks.data?.credentialsAvailable === false;

  return (
    <>
      {confirmDialog}
      <section className="grid gap-4">
        <div className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">{t("networks.title")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("networks.description")}
            </p>
          </header>
          {unavailable && (
            <Alert role="status">
              <AlertDescription className="grid gap-1">
                <strong>{t("networks.credentialsUnavailable")}</strong>
                <p>
                  {networks.data?.credentialsUnavailableReason ??
                    t("networks.credentialsHint")}
                </p>
              </AlertDescription>
            </Alert>
          )}
          {networks.error && (
            <Alert variant="destructive">
              <AlertDescription>
                {t("networks.loadError")} {networks.error.message}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("networks.listTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("networks.listHint")}
            </p>
          </div>
          <RheaButton
            variant="default"
            onClick={() => open("new")}
            disabled={unavailable}
          >
            <Plus size={16} aria-hidden="true" /> {t("networks.add")}
          </RheaButton>
        </div>

        {notice && (
          <Alert role="status">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {networks.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden="true" />
            {t("networks.loading")}
          </p>
        ) : !networks.data?.items.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Wifi size={25} aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{t("networks.empty")}</EmptyTitle>
              <EmptyDescription>{t("networks.emptyHint")}</EmptyDescription>
            </EmptyHeader>
            <RheaButton
              variant="secondary"
              onClick={() => open("new")}
              disabled={unavailable}
            >
              {t("networks.addFirst")}
            </RheaButton>
          </Empty>
        ) : (
          <div className="grid gap-2">
            {networks.data.items.map((network) => (
              <article
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4"
                key={network.id}
              >
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-xl bg-muted"
                  aria-hidden="true"
                >
                  <LockKeyhole size={17} />
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="text-sm font-semibold">
                    {network.name}
                  </strong>
                  <span className="text-sm text-muted-foreground">
                    {network.ssid} · {network.securityLabel}
                  </span>
                  <small className="text-xs text-muted-foreground">
                    {network.credentialSet
                      ? t("networks.credentialSaved")
                      : t("networks.credentialMissing")}{" "}
                    ·{" "}
                    {t("networks.screens", {
                      count: network.assignedScreens,
                    })}{" "}
                    ·{" "}
                    {t("networks.revision", {
                      revision: network.configRevision,
                    })}
                  </small>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <RheaButton
                    variant="secondary"
                    size="sm"
                    onClick={() => open(network)}
                  >
                    <Pencil size={14} aria-hidden="true" /> {t("networks.edit")}
                  </RheaButton>
                  <RheaButton
                    variant="destructive"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => {
                      const warning = network.assignedScreens
                        ? t("networks.deleteAssigned", {
                            name: network.name,
                            count: network.assignedScreens,
                          })
                        : t("networks.deleteTitle", { name: network.name });
                      void confirm({
                        title: warning,
                        action: t("common:actions.delete"),
                        destructive: true,
                      }).then((ok) => {
                        if (ok) remove.mutate(network);
                      });
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />{" "}
                    {t("common:actions.delete")}
                  </RheaButton>
                </span>
              </article>
            ))}
          </div>
        )}

        {remove.error && (
          <Alert variant="destructive">
            <AlertDescription>
              {safeError(remove.error, t("networks.deleteError"))}
            </AlertDescription>
          </Alert>
        )}

        <RheaDialog
          open={Boolean(editing)}
          onOpenChange={(open) => {
            if (!open && !save.isPending) setEditing(undefined);
          }}
        >
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {editing === "new"
                  ? t("networks.addTitle")
                  : t("networks.editTitle")}
              </DialogTitle>
            </DialogHeader>
            {editing && editing !== "new" && detail.isLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner aria-hidden="true" />
                {t("networks.loadingDetail")}
              </p>
            ) : (
              <form
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSaveError(undefined);
                  save.mutate();
                }}
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="presentation-network-name">
                      {t("networks.fields.name")}
                    </FieldLabel>
                    <Input
                      id="presentation-network-name"
                      value={draft.name}
                      maxLength={120}
                      required
                      autoFocus
                      onChange={(event) =>
                        setDraft({ ...draft, name: event.target.value })
                      }
                    />
                    <FieldDescription>
                      {t("networks.fields.nameHint")}
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="presentation-network-ssid">
                      {t("networks.fields.ssid")}
                    </FieldLabel>
                    <Input
                      id="presentation-network-ssid"
                      value={draft.ssid}
                      maxLength={32}
                      required
                      onChange={(event) =>
                        setDraft({ ...draft, ssid: event.target.value })
                      }
                    />
                    <FieldDescription>
                      {t("networks.fields.ssidHint")}
                    </FieldDescription>
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="presentation-network-security">
                      {t("networks.fields.security")}
                    </FieldLabel>
                    <RheaSelect
                      name="security"
                      value={draft.security}
                      onValueChange={(next) => {
                        if (next)
                          setDraft({
                            ...draft,
                            security: next,
                          });
                      }}
                    >
                      <SelectTrigger
                        id="presentation-network-security"
                        aria-label={t("networks.fields.security")}
                      >
                        <SelectValue>
                          {securityLabel(
                            networks.data?.supportedSecurity,
                            draft.security,
                          )}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {(networks.data?.supportedSecurity ?? []).map(
                          (option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </RheaSelect>
                  </Field>
                  <div className="flex items-end pb-2">
                    {/* The wrapping label names the checkbox; no extra aria-label. */}
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <RheaCheckbox
                        checked={draft.hidden}
                        onCheckedChange={(checked) =>
                          setDraft({ ...draft, hidden: checked === true })
                        }
                      />
                      <span>{t("networks.fields.hidden")}</span>
                    </label>
                  </div>
                </div>

                <Field>
                  <FieldLabel htmlFor="presentation-network-secret">
                    {draft.security === "wpa_psk"
                      ? t("networks.fields.secretPsk")
                      : t("networks.fields.secretEnterprise")}
                  </FieldLabel>
                  <Input
                    id="presentation-network-secret"
                    type="password"
                    value={secret}
                    autoComplete="new-password"
                    required={editing === "new"}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                  <FieldDescription>
                    {editing === "new"
                      ? t("networks.fields.secretHintNew")
                      : detail.data?.network.credentialSet
                        ? t("networks.fields.secretHintSaved")
                        : t("networks.fields.secretHintNone")}
                  </FieldDescription>
                </Field>

                {draft.security === "wpa_eap_peap_mschapv2" && (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="presentation-network-identity">
                          {t("networks.fields.identity")}
                        </FieldLabel>
                        <Input
                          id="presentation-network-identity"
                          value={draft.identity}
                          autoComplete="off"
                          required
                          onChange={(event) =>
                            setDraft({ ...draft, identity: event.target.value })
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="presentation-network-anonymous">
                          {t("networks.fields.anonymousIdentity")}
                        </FieldLabel>
                        <Input
                          id="presentation-network-anonymous"
                          value={draft.anonymousIdentity}
                          autoComplete="off"
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              anonymousIdentity: event.target.value,
                            })
                          }
                        />
                        <FieldDescription>
                          {t("networks.fields.anonymousIdentityHint")}
                        </FieldDescription>
                      </Field>
                    </div>
                    <Field>
                      <FieldLabel htmlFor="presentation-network-ca">
                        {t("networks.fields.ca")}
                      </FieldLabel>
                      <Textarea
                        id="presentation-network-ca"
                        value={draft.caCertificatePem}
                        rows={5}
                        spellCheck={false}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            caCertificatePem: event.target.value,
                          })
                        }
                      />
                      <FieldDescription>
                        {t("networks.fields.caHint")}
                      </FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="presentation-network-domain">
                        {t("networks.fields.domain")}
                      </FieldLabel>
                      <Input
                        id="presentation-network-domain"
                        value={draft.domainSuffixMatch}
                        autoComplete="off"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            domainSuffixMatch: event.target.value,
                          })
                        }
                      />
                      <FieldDescription>
                        {t("networks.fields.domainHint")}
                      </FieldDescription>
                    </Field>
                  </>
                )}

                <fieldset className="grid gap-2 rounded-xl border border-border p-4">
                  <legend className="px-1 text-sm font-medium">
                    {t("networks.assignedTitle")}
                  </legend>
                  <p className="text-sm text-muted-foreground">
                    {t("networks.assignedHint")}
                  </p>
                  {screens.isLoading ? (
                    <span className="text-sm text-muted-foreground">
                      {t("networks.loadingPlayers")}
                    </span>
                  ) : linuxScreens.length ? (
                    <div className="grid gap-2">
                      {linuxScreens.map((screen) => (
                        <label
                          key={screen.id}
                          className="flex cursor-pointer items-center gap-2 text-sm"
                        >
                          <RheaCheckbox
                            checked={assignmentIds.includes(screen.id)}
                            onCheckedChange={(checked) =>
                              setAssignmentIds((current) =>
                                checked === true
                                  ? [...new Set([...current, screen.id])]
                                  : current.filter((id) => id !== screen.id),
                              )
                            }
                          />
                          <span>
                            {screen.name} ·{" "}
                            {screen.location || t("networks.noLocation")}
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {t("networks.noPlayers")}
                    </span>
                  )}
                </fieldset>

                {detail.error && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {t("networks.detailError")}{" "}
                      {safeError(detail.error, t("networks.retry"))}
                    </AlertDescription>
                  </Alert>
                )}
                {saveError && (
                  <Alert variant="destructive">
                    <AlertDescription>{saveError}</AlertDescription>
                  </Alert>
                )}
                <DialogFooter>
                  <RheaButton
                    variant="ghost"
                    type="button"
                    onClick={() => setEditing(undefined)}
                    disabled={save.isPending}
                  >
                    {t("common:actions.cancel")}
                  </RheaButton>
                  <RheaButton
                    variant="default"
                    type="submit"
                    disabled={
                      save.isPending ||
                      !draft.name.trim() ||
                      !draft.ssid.trim() ||
                      (editing === "new" && !secret) ||
                      (draft.security === "wpa_eap_peap_mschapv2" &&
                        !draft.identity.trim()) ||
                      Boolean(unavailable && editing === "new")
                    }
                  >
                    {save.isPending && <Spinner />} {t("networks.save")}
                  </RheaButton>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </RheaDialog>
      </section>
    </>
  );
}
