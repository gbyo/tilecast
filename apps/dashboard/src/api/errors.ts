/**
 * Transport-level failure for Tilecast API calls. The server-provided
 * message is used when the error envelope carries one; otherwise Studio
 * falls back to a fixed message so callers can render `error.message`
 * directly without additional lookup.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Fallback when the server answers without a usable error envelope. */
export const FALLBACK_REQUEST_MESSAGE =
  "Tilecast could not complete the request.";

export interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

/** Build the ApiError for a non-2xx response from its parsed body. */
export function apiErrorFromEnvelope(body: unknown, status: number): ApiError {
  const envelope = (body ?? {}) as ErrorEnvelope;
  return new ApiError(
    envelope.error?.message ?? FALLBACK_REQUEST_MESSAGE,
    status,
    envelope.error?.code ?? "unknown_error",
    envelope.error?.details,
  );
}
