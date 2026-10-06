import type { ProjectionContextV1 } from "./contract";

/** Only the host grants a media URI. Missing grants fail closed. */
export class AuthorizedMedia {
  private bindings = new Map<string, string>();

  replace(media: ProjectionContextV1["media"] = []): void {
    const next = new Map<string, string>();
    for (const binding of media) {
      const key = `${binding.assetId}/${binding.variantId}`;
      if (!binding.uri || next.has(key)) {
        throw new Error("Invalid or duplicate media binding");
      }
      next.set(key, binding.uri);
    }
    this.bindings = next;
  }

  resolve(assetId: string, variantId: string): string {
    const uri = this.bindings.get(`${assetId}/${variantId}`);
    if (!uri) throw new Error("Media is not authorized by the host");
    return uri;
  }
}
