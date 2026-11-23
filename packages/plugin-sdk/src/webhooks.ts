/**
 * Inbound webhooks of a Plugin Manifest API 3 plugin
 * (docs/plugin-webhooks.md). This file mirrors
 * packages/plugin-sdk/go/plugin/webhooks_v3.go; the shared fixtures in
 * testdata/manifests keep the two in agreement.
 */

export const WEBHOOK_AUTHENTICATIONS = [
  "token",
  "signature",
  "fetch-back",
] as const;
export const SIGNATURE_SCHEMES = [
  "standard-webhooks",
  "hmac-sha256",
  "verify",
] as const;
export const SIGNATURE_FORMATS = ["plain", "pairs"] as const;
export const SIGNATURE_ENCODINGS = ["hex", "base64"] as const;
export const SIGNED_PAYLOADS = ["body", "timestamp.body", "url.body"] as const;
export const HANDSHAKE_TYPES = ["echo-query", "echo-json"] as const;
export const WEBHOOK_ACK_STATUSES = [200, 202] as const;
export const DEFAULT_WEBHOOK_ACK = 202;

export const MAX_WEBHOOKS = 8;
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
export const MAX_WEBHOOK_HEADERS = 8;
export const MAX_WEBHOOK_POINTER_LENGTH = 128;
export const MAX_FETCH_BACK_PATTERN_LENGTH = 200;

export const webhookIdPattern = /^[a-z][a-z0-9_]{0,39}$/;
export const webhookHeaderPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
export const webhookParameterPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
export const webhookPairKeyPattern = /^[A-Za-z0-9_.-]{1,32}$/;
export const webhookPrefixPattern = /^[\x21-\x7e]{1,16}$/;
const pointerPattern = /^(\/([^~/]|~[01])*)+$/;
const settingPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const deniedHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "proxy-authenticate",
  "host",
  "content-length",
  "forwarded",
  "via",
  "x-real-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "x-client-ip",
  "x-cluster-client-ip",
]);

/** Whether the host refuses to forward a header to a plugin. */
export function webhookHeaderDenied(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    deniedHeaders.has(lower) ||
    lower.startsWith("x-forwarded-") ||
    lower.startsWith("proxy-")
  );
}

export function validWebhookPointer(pointer: string): boolean {
  return (
    pointer.length <= MAX_WEBHOOK_POINTER_LENGTH && pointerPattern.test(pointer)
  );
}

export interface WebhookSignatureDeclaration {
  scheme: string;
  secret?: string;
  header?: string;
  format?: string;
  timestampHeader?: string;
  timestampKey?: string;
  signatureKey?: string;
  prefix?: string;
  encoding?: string;
  signedPayload?: string;
  headers?: string[];
}

export interface WebhookDeclaration {
  id: string;
  title: string;
  description?: string;
  authentication: string;
  ackStatus?: number;
  handshake?: { type: string; parameter?: string; pointer?: string };
  signature?: WebhookSignatureDeclaration;
  deliveryId?: { header?: string; pointer?: string };
  fetchBack?: { eventId: string; pattern: string };
  forwardHeaders?: string[];
}

/** The acknowledgement status of a declaration. */
export function webhookAck(webhook: { ackStatus?: number }): number {
  return webhook.ackStatus ?? DEFAULT_WEBHOOK_ACK;
}

/** Whether a SaaS provider sends the requests, so they need public HTTPS. */
export function webhookRequiresPublicHttps(webhook: {
  authentication: string;
}): boolean {
  return webhook.authentication !== "token";
}

function signatureHeaderName(webhook: WebhookDeclaration): string {
  const signature = webhook.signature;
  if (!signature) return "";
  if (signature.scheme === "standard-webhooks") return "webhook-signature";
  if (signature.scheme === "hmac-sha256") return signature.header ?? "";
  return "";
}

function fetchBackPatternProblem(pattern: string): string | undefined {
  if (
    pattern.length < 2 ||
    pattern.length > MAX_FETCH_BACK_PATTERN_LENGTH ||
    !pattern.startsWith("^") ||
    !pattern.endsWith("$")
  )
    return `use an anchored pattern of at most ${MAX_FETCH_BACK_PATTERN_LENGTH} bytes`;
  try {
    new RegExp(pattern);
  } catch {
    return "does not compile";
  }
  return undefined;
}

function signatureProblems(
  where: string,
  signature: WebhookSignatureDeclaration,
  secrets: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const hmacMembers = [
    signature.header,
    signature.format,
    signature.timestampHeader,
    signature.timestampKey,
    signature.signatureKey,
    signature.prefix,
    signature.encoding,
    signature.signedPayload,
  ];
  const present = (values: (string | undefined)[]) =>
    values.some((value) => value !== undefined && value !== "");
  const headerOK = (name: string | undefined) =>
    !!name && webhookHeaderPattern.test(name) && !webhookHeaderDenied(name);
  switch (signature.scheme) {
    case "standard-webhooks":
      if (present(hmacMembers) || (signature.headers ?? []).length > 0)
        problems.push(
          `${where} uses standard-webhooks; it declares only the secret`,
        );
      break;
    case "hmac-sha256": {
      if ((signature.headers ?? []).length > 0)
        problems.push(`${where} uses hmac-sha256; headers is a verify member`);
      if (!headerOK(signature.header))
        problems.push(
          `${where} signature header "${signature.header ?? ""}" is not a header the host reads`,
        );
      if (signature.encoding !== "hex" && signature.encoding !== "base64")
        problems.push(`${where} signature encoding must be hex or base64`);
      if (
        !(SIGNED_PAYLOADS as readonly (string | undefined)[]).includes(
          signature.signedPayload,
        )
      )
        problems.push(
          `${where} signedPayload must be body, timestamp.body, or url.body`,
        );
      const timestamped = signature.signedPayload === "timestamp.body";
      if (signature.format === "plain") {
        if (signature.timestampKey || signature.signatureKey)
          problems.push(
            `${where} plain format takes no timestampKey or signatureKey`,
          );
        if (timestamped !== !!signature.timestampHeader)
          problems.push(
            `${where} declares timestampHeader exactly when it signs timestamp.body`,
          );
        if (signature.timestampHeader && !headerOK(signature.timestampHeader))
          problems.push(
            `${where} timestampHeader "${signature.timestampHeader}" is not a header the host reads`,
          );
      } else if (signature.format === "pairs") {
        if (signature.timestampHeader)
          problems.push(
            `${where} pairs format reads the timestamp from timestampKey`,
          );
        if (!webhookPairKeyPattern.test(signature.signatureKey ?? ""))
          problems.push(`${where} pairs format needs signatureKey`);
        if (timestamped !== !!signature.timestampKey)
          problems.push(
            `${where} declares timestampKey exactly when it signs timestamp.body`,
          );
        if (
          signature.timestampKey &&
          (!webhookPairKeyPattern.test(signature.timestampKey) ||
            signature.timestampKey === signature.signatureKey)
        )
          problems.push(`${where} timestampKey is invalid`);
      } else {
        problems.push(`${where} signature format must be plain or pairs`);
      }
      if (
        signature.prefix &&
        (!webhookPrefixPattern.test(signature.prefix) ||
          /[, ]/.test(signature.prefix))
      )
        problems.push(
          `${where} signature prefix must be 1 to 16 visible characters without a comma`,
        );
      break;
    }
    case "verify": {
      if (present([...hmacMembers, signature.secret]))
        problems.push(
          `${where} uses a verify hook; it declares only headers, and the hook receives no secret from the host`,
        );
      const seen = new Set<string>();
      for (const name of signature.headers ?? []) {
        const lower = name.toLowerCase();
        if (!headerOK(name) || seen.has(lower))
          problems.push(`${where} verify hook cannot read header "${name}"`);
        seen.add(lower);
      }
      return problems;
    }
    default:
      problems.push(
        `${where} has unknown signature scheme "${signature.scheme}"`,
      );
      return problems;
  }
  if (
    !settingPattern.test(signature.secret ?? "") ||
    !secrets.has(signature.secret ?? "")
  )
    problems.push(
      `${where} signature secret "${signature.secret ?? ""}" is not a secret field of settings.organization`,
    );
  return problems;
}

/** Problems of the webhooks of one manifest, beyond the JSON shape. */
export function webhookProblems(manifest: {
  webhooks?: WebhookDeclaration[];
  settings?: { organization?: { key: string; control: string }[] };
}): string[] {
  const problems: string[] = [];
  const secrets = new Set(
    (manifest.settings?.organization ?? [])
      .filter((field) => field.control === "secret")
      .map((field) => field.key),
  );
  const seen = new Set<string>();
  for (const webhook of manifest.webhooks ?? []) {
    const where = `webhook "${webhook.id}"`;
    if (seen.has(webhook.id)) problems.push(`${where} is declared twice`);
    seen.add(webhook.id);
    switch (webhook.authentication) {
      case "token":
        if (webhook.signature || webhook.fetchBack)
          problems.push(
            `${where} uses token authentication and declares signature or fetchBack`,
          );
        break;
      case "signature":
        if (!webhook.signature || webhook.fetchBack) {
          problems.push(
            `${where} uses signature authentication; it needs signature and no fetchBack`,
          );
          break;
        }
        problems.push(...signatureProblems(where, webhook.signature, secrets));
        if (
          webhook.signature.scheme === "standard-webhooks" &&
          webhook.deliveryId
        )
          problems.push(
            `${where} uses standard-webhooks, whose delivery ID is the webhook-id header; it declares no deliveryId`,
          );
        if (
          webhook.signature.scheme !== "standard-webhooks" &&
          !webhook.deliveryId
        )
          problems.push(
            `${where} needs a deliveryId: the host drops a repeated delivery by it`,
          );
        break;
      case "fetch-back": {
        if (!webhook.fetchBack || webhook.signature || webhook.deliveryId) {
          problems.push(
            `${where} uses fetch-back authentication; it needs fetchBack and no signature or deliveryId`,
          );
          break;
        }
        if (!validWebhookPointer(webhook.fetchBack.eventId))
          problems.push(
            `${where} fetchBack.eventId is not a JSON Pointer of at most ${MAX_WEBHOOK_POINTER_LENGTH} bytes`,
          );
        const problem = fetchBackPatternProblem(webhook.fetchBack.pattern);
        if (problem) problems.push(`${where} fetchBack.pattern: ${problem}`);
        break;
      }
      default:
        problems.push(
          `${where} has unknown authentication "${webhook.authentication}"`,
        );
    }
    const id = webhook.deliveryId;
    if (id) {
      if (!id.header === !id.pointer)
        problems.push(
          `${where} deliveryId names a header or a pointer, not both`,
        );
      else if (
        id.header &&
        (!webhookHeaderPattern.test(id.header) ||
          webhookHeaderDenied(id.header))
      )
        problems.push(
          `${where} deliveryId.header "${id.header}" is not a header the host reads`,
        );
      else if (id.pointer && !validWebhookPointer(id.pointer))
        problems.push(`${where} deliveryId.pointer is not a JSON Pointer`);
    }
    const handshake = webhook.handshake;
    if (handshake?.type === "echo-query") {
      if (
        !webhookParameterPattern.test(handshake.parameter ?? "") ||
        handshake.pointer
      )
        problems.push(
          `${where} echo-query handshake needs a query parameter name and no pointer`,
        );
    } else if (handshake?.type === "echo-json") {
      if (webhook.authentication !== "signature")
        problems.push(
          `${where} echo-json handshake needs signature authentication: the host answers it only after a valid signature`,
        );
      if (!validWebhookPointer(handshake.pointer ?? "") || handshake.parameter)
        problems.push(
          `${where} echo-json handshake needs a JSON Pointer and no parameter`,
        );
    }
    const signatureHeader = signatureHeaderName(webhook).toLowerCase();
    const forwarded = new Set<string>();
    for (const name of webhook.forwardHeaders ?? []) {
      const lower = name.toLowerCase();
      if (!webhookHeaderPattern.test(name) || webhookHeaderDenied(name))
        problems.push(`${where} cannot forward header "${name}"`);
      else if (lower === signatureHeader || lower === "webhook-signature")
        problems.push(`${where} cannot forward its signature header`);
      else if (forwarded.has(lower))
        problems.push(`${where} forwards header "${name}" twice`);
      forwarded.add(lower);
    }
  }
  return problems;
}
