// Plugin Studio code is linted with Studio's own rules and type information,
// because it is compiled into the Studio bundle.
import { fileURLToPath } from "node:url";
import studio from "../apps/dashboard/eslint.config.js";

const tsconfigRootDir = fileURLToPath(
  new URL("../apps/dashboard/", import.meta.url),
);
const studioFiles = ["*/studio/**/*.{ts,tsx}"];

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "eslint.config.mjs"] },
  ...studio
    .filter((config) => !(config.ignores && Object.keys(config).length === 1))
    .map((config) => {
      const parserOptions = config.languageOptions?.parserOptions;
      return {
        ...config,
        files: studioFiles,
        ...(parserOptions?.project
          ? {
              languageOptions: {
                ...config.languageOptions,
                parserOptions: {
                  ...parserOptions,
                  project: ["./tsconfig.app.json"],
                  tsconfigRootDir,
                },
              },
            }
          : {}),
      };
    }),
];
