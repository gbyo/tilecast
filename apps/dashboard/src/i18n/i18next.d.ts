import "i18next";
import type { DEFAULT_NAMESPACE, englishResources } from "./resources";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NAMESPACE;
    resources: typeof englishResources;
  }
}
