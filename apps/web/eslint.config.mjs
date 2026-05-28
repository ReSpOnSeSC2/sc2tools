import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [".next/**", "node_modules/**", "coverage/**", "public/**"],
  },
  ...compat.extends("next/core-web-vitals"),
  {
    rules: {
      // Purely stylistic — apostrophes/quotes in JSX text render identically
      // whether escaped or not. Off to avoid churn on existing copy.
      "react/no-unescaped-entities": "off",
      // Useful for debugging but non-blocking; some inline components (e.g.
      // arcade cell renderers) intentionally omit a display name.
      "react/display-name": "warn",
      // File-size guideline (not a hard cap): surfaces oversized files for a
      // "is this doing too much?" review without blocking the build. Counts
      // code lines only. Note: covers JS/TS only — Python files aren't linted
      // here.
      "max-lines": ["warn", { max: 800, skipBlankLines: true, skipComments: true }],
    },
  },
];

export default config;
