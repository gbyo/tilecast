/**
 * `@tilecast/data-source-sdk`: the declarative Data Source contract.
 * Manifests, the Data Types registry, adapter vocabulary with FetchSpec
 * conformance, authored setup, and source-aware discovery. Executable
 * refresh and caching stay behind the Server's adapters; a manifest
 * names an adapter id but never an implementation.
 */
export {
  dataSourceManifestSchema,
  dataSourceManifestJSONSchema,
  dataSourceDirPattern,
  dataSourceIdPattern,
  configKeyPattern,
  adapterIds,
  MANIFEST_FILE,
  type DataSourceManifest,
  type DataSourceManifestInput,
  type FetchDeclaration,
} from "./manifest.ts";
export {
  DATA_TYPES,
  DATA_TYPE_NAMES,
  dataTypeProblem,
  type DataTypeDefinition,
} from "./datatypes.ts";
export {
  ADAPTER_IDS,
  DECLARATIVE_ADAPTERS,
  adapterProblem,
  adapterDeclarativeProblem,
  adapterTakesFetch,
  fetchSpecProblems,
  type AdapterId,
  type DeclarativeAdapter,
  type FetchConfigField,
  type FetchDeclarationInput,
} from "./fetch.ts";
export { setupGuideProblems, type SetupGuide } from "./setup.ts";
export {
  discoverSourcedDataSources,
  entryDir,
  pluginIdResolver,
  sourceForDataSourceManifestPath,
  type DataSourceDiscovery,
  type DataSourceEntry,
  type PluginIdResolver,
} from "./discovery.ts";
export type { ExtensionSource } from "@tilecast/widget-sdk";
