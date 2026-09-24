import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
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
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";
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

export function PresentationNetworksPanel({
  canManage,
}: {
  canManage: boolean;
}) {
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
      toast.add({
        title:
          editing === "new"
            ? "Presentation Network created."
            : "Presentation Network updated.",
        type: "success",
      });
      setEditing(undefined);
      setSecret("");
      await client.invalidateQueries({ queryKey: ["presentation-networks"] });
      await client.invalidateQueries({ queryKey: ["presentation-network"] });
      await client.invalidateQueries({ queryKey: ["screens"] });
    },
  });

  const remove = useMutation({
    mutationFn: (network: PresentationNetwork) =>
      api.deletePresentationNetwork(network.id, csrf),
    onSuccess: async () => {
      toast.add({ title: "Presentation Network deleted.", type: "success" });
      await client.invalidateQueries({ queryKey: ["presentation-networks"] });
      await client.invalidateQueries({ queryKey: ["screens"] });
    },
  });

  const open = (network: PresentationNetwork | "new") => {
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
      setSaveError(
        safeError(save.error, "The Presentation Network could not be saved."),
      );
  }, [save.error]);

  if (!canManage)
    return (
      <Alert role="status">
        <AlertDescription>
          Only Owners and Administrators may manage Presentation Networks.
        </AlertDescription>
      </Alert>
    );

  const unavailable = networks.data?.credentialsAvailable === false;

  return (
    <>
      {confirmDialog}
      <section className="grid gap-4">
        <div className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              Temporary Wi-Fi for local presentation
            </h3>
            <p className="text-sm text-muted-foreground">
              Presentation Networks let supported Linux players join Wi-Fi only
              while an AirPlay session needs it. Ethernet remains the normal
              path for Tilecast traffic, downloads, and group video fan-out.
            </p>
          </header>
          {unavailable && (
            <Alert role="status">
              <AlertDescription className="grid gap-1">
                <strong>Credentials are unavailable on this server.</strong>
                <p>
                  {networks.data?.credentialsUnavailableReason ??
                    "Configure the Presentation Network encryption key before saving a network."}
                </p>
              </AlertDescription>
            </Alert>
          )}
          {networks.error && (
            <Alert variant="destructive">
              <AlertDescription>
                Could not load Presentation Networks. {networks.error.message}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h3 className="text-base font-semibold">Presentation Networks</h3>
            <p className="text-sm text-muted-foreground">
              Credentials are write-only. Editing a network without entering a
              new credential keeps the saved one.
            </p>
          </div>
          <Button
            variant="default"
            onClick={() => open("new")}
            disabled={unavailable}
          >
            <Plus size={16} aria-hidden="true" /> Add network
          </Button>
        </div>

        {networks.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden="true" />
            Loading Presentation Networks…
          </p>
        ) : !networks.data?.items.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Wifi size={25} aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No Presentation Networks yet</EmptyTitle>
              <EmptyDescription>
                Add a staff, guest, or event Wi-Fi network when AirPlay senders
                cannot reach a player over Ethernet alone.
              </EmptyDescription>
            </EmptyHeader>
            <Button
              variant="secondary"
              onClick={() => open("new")}
              disabled={unavailable}
            >
              Add the first network
            </Button>
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
                      ? "Credential saved"
                      : "Credential missing"}{" "}
                    · {network.assignedScreens} screen
                    {network.assignedScreens === 1 ? "" : "s"} · revision{" "}
                    {network.configRevision}
                  </small>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => open(network)}
                  >
                    <Pencil size={14} aria-hidden="true" /> Edit
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => {
                      const warning = network.assignedScreens
                        ? `${network.name} is assigned to ${network.assignedScreens} screen${network.assignedScreens === 1 ? "" : "s"}. Delete it and remove those assignments?`
                        : `Delete ${network.name}?`;
                      void confirm({
                        title: warning,
                        action: "Delete",
                        destructive: true,
                      }).then((ok) => {
                        if (ok) remove.mutate(network);
                      });
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" /> Delete
                  </Button>
                </span>
              </article>
            ))}
          </div>
        )}

        {remove.error && (
          <Alert variant="destructive">
            <AlertDescription>
              {safeError(
                remove.error,
                "The Presentation Network could not be deleted.",
              )}
            </AlertDescription>
          </Alert>
        )}

        <Dialog
          open={Boolean(editing)}
          onOpenChange={(open) => {
            if (!open && !save.isPending) setEditing(undefined);
          }}
        >
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {editing === "new"
                  ? "Add Presentation Network"
                  : "Edit Presentation Network"}
              </DialogTitle>
            </DialogHeader>
            {editing && editing !== "new" && detail.isLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner aria-hidden="true" />
                Loading network details…
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
                      Display name
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
                      A name operators will recognize in Studio.
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="presentation-network-ssid">
                      SSID
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
                      The Wi-Fi name, not the Studio display name.
                    </FieldDescription>
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="presentation-network-security">
                      Authentication
                    </FieldLabel>
                    <Select
                      items={networks.data?.supportedSecurity ?? []}
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
                        aria-label="Authentication"
                      >
                        <SelectValue />
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
                    </Select>
                  </Field>
                  <div className="flex items-end pb-2">
                    <Field orientation="horizontal" className="items-center">
                      <Checkbox
                        id="presentation-network-hidden"
                        checked={draft.hidden}
                        onCheckedChange={(checked) =>
                          setDraft({ ...draft, hidden: checked === true })
                        }
                      />
                      <FieldLabel
                        htmlFor="presentation-network-hidden"
                        className="font-normal"
                      >
                        Hidden SSID
                      </FieldLabel>
                    </Field>
                  </div>
                </div>

                <Field>
                  <FieldLabel htmlFor="presentation-network-secret">
                    {draft.security === "wpa_psk"
                      ? "Wi-Fi password / PSK"
                      : "Enterprise password"}
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
                      ? "Write-only. It is encrypted before it is stored."
                      : detail.data?.network.credentialSet
                        ? "A credential is saved. Leave this blank to keep it, or enter a new one to rotate it."
                        : "No credential is saved yet; enter one to enable provisioning."}
                  </FieldDescription>
                </Field>

                {draft.security === "wpa_eap_peap_mschapv2" && (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="presentation-network-identity">
                          Enterprise identity
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
                          Anonymous identity
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
                          Optional outer identity for the RADIUS server.
                        </FieldDescription>
                      </Field>
                    </div>
                    <Field>
                      <FieldLabel htmlFor="presentation-network-ca">
                        CA certificate
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
                        Optional public CA certificate in PEM form. It is used
                        to validate the RADIUS server.
                      </FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="presentation-network-domain">
                        Expected server domain
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
                        Requires a CA certificate when set.
                      </FieldDescription>
                    </Field>
                  </>
                )}

                <FieldSet className="grid gap-2 rounded-xl border border-border p-4">
                  <FieldLegend variant="label" className="mb-0 px-1">
                    Assigned Linux players
                  </FieldLegend>
                  <p className="text-sm text-muted-foreground">
                    Only the selected gateway joins this network during a group
                    AirPlay session. Followers stay on Ethernet.
                  </p>
                  {screens.isLoading ? (
                    <span className="text-sm text-muted-foreground">
                      Loading Linux players…
                    </span>
                  ) : linuxScreens.length ? (
                    <div className="grid gap-2">
                      {linuxScreens.map((screen) => (
                        <Field
                          key={screen.id}
                          orientation="horizontal"
                          className="items-center"
                        >
                          <Checkbox
                            id={"presentation-network-screen-" + screen.id}
                            checked={assignmentIds.includes(screen.id)}
                            onCheckedChange={(checked) =>
                              setAssignmentIds((current) =>
                                checked === true
                                  ? [...new Set([...current, screen.id])]
                                  : current.filter((id) => id !== screen.id),
                              )
                            }
                          />
                          <FieldLabel
                            htmlFor={"presentation-network-screen-" + screen.id}
                            className="font-normal"
                          >
                            {screen.name} · {screen.location || "No location"}
                          </FieldLabel>
                        </Field>
                      ))}
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      No Linux players are available for assignment.
                    </span>
                  )}
                </FieldSet>

                {detail.error && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      Could not load this network.{" "}
                      {safeError(detail.error, "Try again.")}
                    </AlertDescription>
                  </Alert>
                )}
                {saveError && (
                  <Alert variant="destructive">
                    <AlertDescription>{saveError}</AlertDescription>
                  </Alert>
                )}
                <DialogFooter>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => setEditing(undefined)}
                    disabled={save.isPending}
                  >
                    Cancel
                  </Button>
                  <Button
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
                    {save.isPending && <Spinner />}
                    Save network
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </section>
    </>
  );
}
