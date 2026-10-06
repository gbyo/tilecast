import { apiGet, apiPost, apiPut } from "../transport";
import type { BrowserScreenInput } from "../types";

export function createBrowserPlayer(
  input: BrowserScreenInput,
  csrfToken: string,
) {
  return apiPost("/api/v1/screens/browser", { body: input, csrfToken });
}
export function browserPlayerSlot(id: string) {
  return apiGet("/api/v1/screens/{id}/browser", { params: { path: { id } } });
}
export function setBrowserRecovery(
  id: string,
  enabled: boolean,
  csrfToken: string,
) {
  return apiPut("/api/v1/screens/{id}/browser/recovery", {
    params: { path: { id } },
    body: { enabled },
    csrfToken,
  });
}
