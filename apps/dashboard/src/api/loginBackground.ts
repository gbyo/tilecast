import { apiDelete, apiGet, apiPut } from "./transport";

export type LoginBackground = {
  assetId?: string;
  imageUrl: string;
};

export async function getLoginBackground(): Promise<LoginBackground> {
  const wire = await apiGet("/api/v1/settings/login-background");
  // The server serializes an unset selection as null; Studio models an
  // absent selection as undefined.
  return { ...wire, assetId: wire.assetId ?? undefined };
}

export async function setLoginBackground(
  assetId: string,
  csrfToken: string,
): Promise<LoginBackground> {
  const wire = await apiPut("/api/v1/settings/login-background", {
    body: { assetId },
    csrfToken,
  });
  return { ...wire, assetId: wire.assetId ?? undefined };
}

export function clearLoginBackground(csrfToken: string): Promise<void> {
  return apiDelete("/api/v1/settings/login-background", { csrfToken });
}
