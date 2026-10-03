import type { TFunction } from "i18next";
import { ApiError } from "../api/errors";
import type { PairingRequest } from "../api/types";

export type PairingT = TFunction<"screens", undefined>;

export type PairingDestination =
  | "automatic"
  | "new_screen"
  | "credential_repair"
  | "replace_hardware";

export type ApprovalForm = {
  name: string;
  locationId?: string;
  roomName: string;
  roomNumber: string;
  description: string;
};

export const pairingApprovalPayload = (
  request: PairingRequest,
  values: ApprovalForm,
  destination: PairingDestination = "automatic",
  replacementScreenId?: string,
) => ({
  ...values,
  replaceExistingCredential:
    destination === "credential_repair" ||
    (destination === "automatic" &&
      request.previouslyPaired &&
      request.hasActiveCredential),
  ...(destination === "replace_hardware"
    ? { replaceHardware: true, replacementScreenId }
    : {}),
});

export const pairingApprovalLabel = (
  request: PairingRequest,
  t: PairingT,
  destination: PairingDestination = "automatic",
) =>
  destination === "replace_hardware"
    ? t("approval.actionReplace")
    : destination === "credential_repair" ||
        (destination === "automatic" &&
          request.previouslyPaired &&
          request.hasActiveCredential)
      ? t("approval.actionRepair")
      : t("approval.actionApprove");

/** A recognized player leads with credential repair; anything else is new. */
export function defaultPairingDestination(
  request: PairingRequest,
): "new_screen" | "credential_repair" {
  return request.previouslyPaired && request.hasActiveCredential
    ? "credential_repair"
    : "new_screen";
}

/** The physical device description from the player's reported metadata. */
export function deviceLabel(request: PairingRequest): string {
  return (
    `${request.metadata.manufacturer} ${request.metadata.model}`.trim() ||
    request.metadata.platform
  );
}

/**
 * Credential repair preserves the logical screen server-side: the approval's
 * logical fields are ignored on that branch, but the contract still requires
 * a valid name. Send the existing name so the request never carries blank
 * metadata that could read as an edit.
 */
export function repairApprovalInput(request: PairingRequest): ApprovalForm {
  return {
    name: request.existingScreenName ?? deviceLabel(request),
    locationId: undefined,
    roomName: "",
    roomNumber: "",
    description: "",
  };
}

/**
 * Hardware replacement skips logical-field validation server-side; only the
 * replacement target matters. The flow asks for nothing else.
 */
export function hardwareApprovalInput(): ApprovalForm {
  return {
    name: "",
    locationId: undefined,
    roomName: "",
    roomNumber: "",
    description: "",
  };
}

/**
 * Maps a resolve failure to translated copy. Known lookup outcomes get their
 * own message; anything else, including network failure, shares the generic
 * resolve error. Server exception text is never shown.
 */
export function resolvePairingErrorMessage(error: unknown, t: PairingT): string {
  if (error instanceof ApiError) {
    if (error.status === 404 || error.code === "not_found")
      return t("pair.notFound");
    if (error.status === 410 || error.code === "pairing_expired")
      return t("pair.expired");
  }
  return t("pair.resolveError");
}

/** Short local expiry time shared by the review card and pending list. */
export function formatPairingExpiry(expiresAt: string, locale: string): string {
  return new Date(expiresAt).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function platformLabel(value: string, t: PairingT): string {
  const normalized = value.toLowerCase();
  if (normalized === "linux") return t("platform.linux");
  if (normalized.includes("fire")) return t("platform.fireTv");
  if (normalized.includes("google")) return t("platform.googleTv");
  if (normalized.includes("android")) return t("platform.androidTv");
  return value || t("platform.unknown");
}
