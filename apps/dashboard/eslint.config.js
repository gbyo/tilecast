import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage"] },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        project: ["./tsconfig.app.json", "./tsconfig.node.json"],
      },
    },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": "off",

      // eslint-plugin-react-hooks v7 folds the React Compiler ruleset into
      // "recommended". Those rules flag 45 pre-existing sites across 26 files
      // (30 of them setState-in-effect), and each fix is a real behavioural
      // refactor rather than dependency-bump fallout. Keep them off so this
      // upgrade preserves the previous lint contract; adopting the compiler
      // ruleset belongs in its own PR, one rule at a time.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/incompatible-library": "off",
      "react-hooks/use-memo": "off",
      "react-hooks/purity": "off",
    },
  },
);
