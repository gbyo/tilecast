/**
 * One low-level typed browser transport for ordinary Tilecast JSON APIs.
 * It owns HTTP mechanics only: same-origin credentials, typed
 * path/query/body shapes from the generated OpenAPI contract, the
 * standard `{ data }` success envelope, the `{ error }` failure
 * envelope, ApiError mapping, abort signals, 204 handling, and
 * malformed/non-JSON responses. It carries no domain logic, no React,
 * and no authentication state: callers that need `X-CSRF-Token` pass the
 * token explicitly at the domain boundary and the transport attaches it.
 *
 * Raw `fetch` stays for genuinely exceptional transports (image/blob
 * acquisition, streaming, file upload/download paths, and browser
 * security ceremonies), never for ordinary JSON.
 */
import createClient, {
  type ClientPathsWithMethod,
  type FetchOptions,
} from "openapi-fetch";
import type { paths } from "@tilecast/api-schema/generated/openapi";
import {
  ApiError,
  FALLBACK_REQUEST_MESSAGE,
  apiErrorFromEnvelope,
} from "./errors";

const baseUrl =
  typeof globalThis.location === "object" &&
  typeof globalThis.location.origin === "string"
    ? globalThis.location.origin
    : "http://localhost";

/**
 * openapi-fetch speaks Request; Studio's long-standing fetch convention is
 * `fetch(urlString, init)` with same-origin credentials, and the
 * component-test stub suite is written against that shape. The adapter
 * keeps the call shape (plain header object, string body, explicit
 * credentials, abort signal) while openapi-fetch keeps owning URL
 * building, parameter serialization, and response typing.
 */
async function studioFetch(input: Request): Promise<Response> {
  const headers: Record<string, string> = {};
  input.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const init: RequestInit = {
    method: input.method,
    headers,
    credentials: "same-origin",
    signal: input.signal,
  };
  if (input.method !== "GET" && input.method !== "HEAD") {
    init.body = await input.text();
  }
  return globalThis.fetch(input.url, init);
}

const raw = createClient<paths>({ baseUrl, fetch: studioFetch });

type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head";

function verbKey(method: HttpMethod): Uppercase<HttpMethod> {
  return method.toUpperCase() as Uppercase<HttpMethod>;
}

export type StudioClient = typeof raw;

export interface TransportCallOptions {
  signal?: AbortSignal;
  csrfToken?: string;
  /**
   * Additional headers for ceremonies that need them (for example the
   * WebAuthn X-MFA-Challenge). The CSRF token stays an explicit,
   * authoritative option so it cannot be smuggled through here.
   */
  headers?: Record<string, string>;
}

type OperationOf<P extends keyof paths, M extends HttpMethod> = Extract<
  paths[P][M],
  { responses: unknown }
>;

type ResponsesOf<O> = O extends { responses: infer R } ? R : never;

type Json2xxBody<R> = {
  [K in keyof R]: K extends 200 | 201 | 202 | 203 | 206 | 207 | 208 | 226
    ? R[K] extends { content: { "application/json": infer B } }
      ? B
      : never
    : never;
}[keyof R];

type UnwrapEnvelope<B> = B extends { data: infer D } ? D : B;

export type SuccessData<P extends keyof paths, M extends HttpMethod> = [
  Json2xxBody<ResponsesOf<OperationOf<P, M>>>,
] extends [never]
  ? undefined
  : UnwrapEnvelope<Json2xxBody<ResponsesOf<OperationOf<P, M>>>>;

export type TypedFetchOptions<
  P extends keyof paths,
  M extends HttpMethod,
> = Omit<FetchOptions<OperationOf<P, M>>, "signal" | "params"> & {
  /**
   * Path/query parameters stay contract-typed. The header bag stays
   * optional at the domain boundary because `call` fills the CSRF
   * header from `csrfToken`; openapi-fetch serializes the rest.
   * Callers pass `params` only for values the contract declares.
   */
  params?: FetchOptions<OperationOf<P, M>> extends { params?: infer Q }
    ? Omit<Q, "header"> & {
        header?: Q extends { header?: infer H } ? H : never;
      }
    : never;
} & TransportCallOptions;

function toApiError(status: number, body: unknown): ApiError {
  if (typeof body !== "string") return apiErrorFromEnvelope(body, status);
  if (!body) return apiErrorFromEnvelope({}, status);
  try {
    return apiErrorFromEnvelope(JSON.parse(body), status);
  } catch {
    return new ApiError(FALLBACK_REQUEST_MESSAGE, status, "malformed_error");
  }
}

function parseSuccessText(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(FALLBACK_REQUEST_MESSAGE, 0, "malformed_response");
  }
}

async function call<P extends keyof paths, M extends HttpMethod>(
  method: M,
  path: P,
  options?: TypedFetchOptions<P, M>,
): Promise<SuccessData<P, M>> {
  const {
    signal,
    csrfToken,
    headers: extraHeaders,
    params,
    ...rest
  } = options ?? {};
  const headers = {
    ...((rest as { headers?: HeadersInit }).headers as Record<string, string>),
    ...extraHeaders,
    ...(csrfToken === undefined ? {} : { "X-CSRF-Token": csrfToken }),
  };
  const mergedParams =
    csrfToken === undefined
      ? params
      : {
          ...(params as Record<string, unknown>),
          header: {
            ...(params as { header?: Record<string, string> } | undefined)
              ?.header,
            "X-CSRF-Token": csrfToken,
          },
        };
  // A record view of the client keeps the dynamic dispatch without
  // method references (unbound-method). The case conversion is asserted
  // once, on the concrete method union, in verbKey below.
  const verbs = raw as unknown as Record<
    Uppercase<HttpMethod>,
    (
      p: string,
      o?: Record<string, unknown>,
    ) => Promise<{ response: Response; data?: unknown; error?: unknown }>
  >;
  let result: { response: Response; data?: unknown; error?: unknown };
  try {
    result = await verbs[verbKey(method)](path, {
      ...(rest as Record<string, unknown>),
      params: mergedParams,
      headers,
      signal,
      parseAs: "text",
    });
  } catch (error) {
    if (
      signal?.aborted ||
      (error as Error | undefined)?.name === "AbortError"
    ) {
      throw error;
    }
    throw new ApiError(FALLBACK_REQUEST_MESSAGE, 0, "network_error");
  }
  const { response } = result;
  if (!response.ok) throw toApiError(response.status, result.error);
  if (response.status === 204) return undefined as SuccessData<P, M>;
  const rawBody = result.data;
  if (rawBody !== null && typeof rawBody === "object") {
    if ("data" in (rawBody as Record<string, unknown>)) {
      return (rawBody as { data: SuccessData<P, M> }).data;
    }
    return undefined as SuccessData<P, M>;
  }
  const body = parseSuccessText(typeof rawBody === "string" ? rawBody : "");
  if (
    body !== null &&
    typeof body === "object" &&
    "data" in (body as Record<string, unknown>)
  ) {
    return (body as { data: SuccessData<P, M> }).data;
  }
  // Some endpoints answer 200 with an empty body; preserve the legacy
  // behavior of resolving undefined rather than failing the call.
  return undefined as SuccessData<P, M>;
}

/**
 * The explicit response type covers endpoints whose success body the
 * contract does not type yet. Path, query, and body stay contract-typed;
 * the response falls back to a local Studio type until the contract
 * gains a schema, at which point the override is removed.
 */
export function apiGet<
  P extends ClientPathsWithMethod<StudioClient, "get">,
  T = SuccessData<P, "get">,
>(path: P, options?: TypedFetchOptions<P, "get">): Promise<T> {
  return call("get", path, options) as Promise<T>;
}

export function apiPost<
  P extends ClientPathsWithMethod<StudioClient, "post">,
  T = SuccessData<P, "post">,
>(path: P, options?: TypedFetchOptions<P, "post">): Promise<T> {
  return call("post", path, options) as Promise<T>;
}

export function apiPut<
  P extends ClientPathsWithMethod<StudioClient, "put">,
  T = SuccessData<P, "put">,
>(path: P, options?: TypedFetchOptions<P, "put">): Promise<T> {
  return call("put", path, options) as Promise<T>;
}

export function apiPatch<
  P extends ClientPathsWithMethod<StudioClient, "patch">,
  T = SuccessData<P, "patch">,
>(path: P, options?: TypedFetchOptions<P, "patch">): Promise<T> {
  return call("patch", path, options) as Promise<T>;
}

export function apiDelete<
  P extends ClientPathsWithMethod<StudioClient, "delete">,
  T = SuccessData<P, "delete">,
>(path: P, options?: TypedFetchOptions<P, "delete">): Promise<T> {
  return call("delete", path, options) as Promise<T>;
}

export function apiHead<
  P extends ClientPathsWithMethod<StudioClient, "head">,
  T = SuccessData<P, "head">,
>(path: P, options?: TypedFetchOptions<P, "head">): Promise<T> {
  return call("head", path, options) as Promise<T>;
}
