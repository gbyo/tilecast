import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole, Pencil, Plus, Trash2, Wifi } from "lucide-react";
import { api } from "../api/client";
import type {
  PresentationNetwork,
  PresentationNetworkInput,
  PresentationNetworkSecurity,
  Screen,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Select,
  Textarea,
} from "../components/ui";

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
  const { confirm } = useSpectrumDialogs();
  const auth = useAuth();
  const client = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
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
      setNotice("Presentation Network saved.");
      await client.invalidateQueries({ queryKey: ["presentation-networks"] });
      await client.invalidateQueries({ queryKey: ["presentation-network"] });
      await client.invalidateQueries({ queryKey: ["screens"] });
    },
  });

  const remove = useMutation({
    mutationFn: (network: PresentationNetwork) =>
      api.deletePresentationNetwork(network.id, csrf),
    onSuccess: async () => {
      setNotice("Presentation Network deleted.");
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
      setSaveError(
        safeError(save.error, "The Presentation Network could not be saved."),
      );
  }, [save.error]);

  if (!canManage)
    return (
      <div className="notice">
        Only Owners and Administrators may manage Presentation Networks.
      </div>
    );

  const unavailable = networks.data?.credentialsAvailable === false;

  return (
    <section className="presentation-networks-settings">
      <div className="settings-subsection presentation-networks-settings__intro">
        <header>
          <h3>Temporary Wi-Fi for local presentation</h3>
          <p>
            Presentation Networks let supported Linux players join Wi-Fi only
            while an AirPlay session needs it. Ethernet remains the normal path
            for Tilecast traffic, downloads, and group video fan-out.
          </p>
        </header>
        {unavailable && (
          <div className="notice notice--warning" role="alert">
            <strong>Credentials are unavailable on this server.</strong>
            <p>
              {networks.data?.credentialsUnavailableReason ??
                "Configure the Presentation Network encryption key before saving a network."}
            </p>
          </div>
        )}
        {networks.error && (
          <div className="notice notice--error" role="alert">
            Could not load Presentation Networks. {networks.error.message}
          </div>
        )}
      </div>

      <div className="presentation-networks-settings__toolbar">
        <div>
          <h3>Presentation Networks</h3>
          <p>
            Credentials are write-only. Editing a network without entering a new
            credential keeps the saved one.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => open("new")}
          disabled={unavailable}
        >
          <Plus size={16} aria-hidden="true" /> Add network
        </Button>
      </div>

      {notice && <div className="notice notice--info">{notice}</div>}
      {networks.isLoading ? (
        <div className="table-loading">Loading Presentation Networks…</div>
      ) : !networks.data?.items.length ? (
        <div className="presentation-networks-empty">
          <Wifi size={25} aria-hidden="true" />
          <h3>No Presentation Networks yet</h3>
          <p>
            Add a staff, guest, or event Wi-Fi network when AirPlay senders
            cannot reach a player over Ethernet alone.
          </p>
          <Button
            variant="secondary"
            onClick={() => open("new")}
            disabled={unavailable}
          >
            Add the first network
          </Button>
        </div>
      ) : (
        <div className="presentation-network-list">
          {networks.data.items.map((network) => (
            <article className="presentation-network-row" key={network.id}>
              <span
                className="presentation-network-row__icon"
                aria-hidden="true"
              >
                <LockKeyhole size={17} />
              </span>
              <span className="presentation-network-row__details">
                <strong>{network.name}</strong>
                <span>
                  {network.ssid} · {network.securityLabel}
                </span>
                <small>
                  {network.credentialSet
                    ? "Credential saved"
                    : "Credential missing"}{" "}
                  · {network.assignedScreens} screen
                  {network.assignedScreens === 1 ? "" : "s"} · revision{" "}
                  {network.configRevision}
                </small>
              </span>
              <span className="presentation-network-row__actions">
                <Button compact onClick={() => open(network)}>
                  <Pencil size={14} aria-hidden="true" /> Edit
                </Button>
                <Button
                  compact
                  variant="danger"
                  disabled={remove.isPending}
                  onClick={async () => {
                    const warning = network.assignedScreens
                      ? `${network.name} is assigned to ${network.assignedScreens} screen${network.assignedScreens === 1 ? "" : "s"}. Delete it and remove those assignments?`
                      : `Delete ${network.name}?`;
                    if (await confirm({
                      title: `Delete ${network.name}?`,
                      description: warning,
                      confirmLabel: "Delete network",
                      tone: "negative",
                    })) remove.mutate(network);
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
        <div className="notice notice--error" role="alert">
          {safeError(
            remove.error,
            "The Presentation Network could not be deleted.",
          )}
        </div>
      )}

      <Dialog
        open={Boolean(editing)}
        title={
          editing === "new"
            ? "Add Presentation Network"
            : "Edit Presentation Network"
        }
        onClose={() => {
          if (!save.isPending) setEditing(undefined);
        }}
        className="presentation-network-dialog"
      >
        {editing && editing !== "new" && detail.isLoading ? (
          <div className="table-loading">Loading network details…</div>
        ) : (
          <form
            className="presentation-network-form"
            onSubmit={(event) => {
              event.preventDefault();
              setSaveError(undefined);
              save.mutate();
            }}
          >
            <div className="form-grid">
              <Field
                label="Display name"
                description="A name operators will recognize in Studio."
                required
              >
                <input
                  value={draft.name}
                  maxLength={120}
                  required
                  autoFocus
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </Field>
              <Field
                label="SSID"
                description="The Wi-Fi name, not the Studio display name."
                required
              >
                <input
                  value={draft.ssid}
                  maxLength={32}
                  required
                  onChange={(event) =>
                    setDraft({ ...draft, ssid: event.target.value })
                  }
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="Authentication" required>
                <Select
                  value={draft.security}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      security: event.target
                        .value as PresentationNetworkSecurity,
                    })
                  }
                >
                  {(networks.data?.supportedSecurity ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="presentation-network-form__checkbox">
                <Checkbox
                  label="Hidden SSID"
                  checked={draft.hidden}
                  onChange={(event) =>
                    setDraft({ ...draft, hidden: event.target.checked })
                  }
                />
              </div>
            </div>

            <Field
              label={
                draft.security === "wpa_psk"
                  ? "Wi-Fi password / PSK"
                  : "Enterprise password"
              }
              description={
                editing === "new"
                  ? "Write-only. It is encrypted before it is stored."
                  : detail.data?.network.credentialSet
                    ? "A credential is saved. Leave this blank to keep it, or enter a new one to rotate it."
                    : "No credential is saved yet; enter one to enable provisioning."
              }
              required={editing === "new"}
            >
              <input
                type="password"
                value={secret}
                autoComplete="new-password"
                required={editing === "new"}
                onChange={(event) => setSecret(event.target.value)}
              />
            </Field>

            {draft.security === "wpa_eap_peap_mschapv2" && (
              <>
                <div className="form-grid">
                  <Field label="Enterprise identity" required>
                    <input
                      value={draft.identity}
                      autoComplete="off"
                      required
                      onChange={(event) =>
                        setDraft({ ...draft, identity: event.target.value })
                      }
                    />
                  </Field>
                  <Field
                    label="Anonymous identity"
                    description="Optional outer identity for the RADIUS server."
                  >
                    <input
                      value={draft.anonymousIdentity}
                      autoComplete="off"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          anonymousIdentity: event.target.value,
                        })
                      }
                    />
                  </Field>
                </div>
                <Field
                  label="CA certificate"
                  description="Optional public CA certificate in PEM form. It is used to validate the RADIUS server."
                >
                  <Textarea
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
                </Field>
                <Field
                  label="Expected server domain"
                  description="Requires a CA certificate when set."
                >
                  <input
                    value={draft.domainSuffixMatch}
                    autoComplete="off"
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        domainSuffixMatch: event.target.value,
                      })
                    }
                  />
                </Field>
              </>
            )}

            <fieldset className="presentation-network-assignments">
              <legend>Assigned Linux players</legend>
              <p>
                Only the selected gateway joins this network during a group
                AirPlay session. Followers stay on Ethernet.
              </p>
              {screens.isLoading ? (
                <span className="field__hint">Loading Linux players…</span>
              ) : linuxScreens.length ? (
                <div className="presentation-network-assignments__list">
                  {linuxScreens.map((screen) => (
                    <Checkbox
                      key={screen.id}
                      label={`${screen.name} · ${screen.location || "No location"}`}
                      checked={assignmentIds.includes(screen.id)}
                      onChange={(event) =>
                        setAssignmentIds((current) =>
                          event.target.checked
                            ? [...new Set([...current, screen.id])]
                            : current.filter((id) => id !== screen.id),
                        )
                      }
                    />
                  ))}
                </div>
              ) : (
                <span className="field__hint">
                  No Linux players are available for assignment.
                </span>
              )}
            </fieldset>

            {detail.error && (
              <div className="notice notice--error" role="alert">
                Could not load this network.{" "}
                {safeError(detail.error, "Try again.")}
              </div>
            )}
            {saveError && (
              <div className="notice notice--error" role="alert">
                {saveError}
              </div>
            )}
            <footer className="dialog-actions">
              <Button
                variant="quiet"
                type="button"
                onClick={() => setEditing(undefined)}
                disabled={save.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                loading={save.isPending}
                disabled={
                  !draft.name.trim() ||
                  !draft.ssid.trim() ||
                  (editing === "new" && !secret) ||
                  (draft.security === "wpa_eap_peap_mschapv2" &&
                    !draft.identity.trim()) ||
                  Boolean(unavailable && editing === "new")
                }
              >
                Save network
              </Button>
            </footer>
          </form>
        )}
      </Dialog>
    </section>
  );
}
