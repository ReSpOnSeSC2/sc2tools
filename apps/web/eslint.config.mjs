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
    },
  },
];

export default config;
