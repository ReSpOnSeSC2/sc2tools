"use strict";

const globals = require("globals");

const HTTP_STATUSES = [200, 201, 204, 400, 401, 403, 404, 409, 413, 418, 429, 500];
const COMMON_NUMBERS = [-1, 0, 1, 2, 3, 5, 10, 100, 1000];

module.exports = [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true, varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
      "no-magic-numbers": [
        "warn",
        {
          ignore: [...COMMON_NUMBERS, ...HTTP_STATUSES],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
        },
      ],
      "max-lines": ["error", { max: 800, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
      "complexity": ["error", { max: 10 }],
      "max-depth": ["error", { max: 3 }],
      "max-params": ["error", { max: 4 }],
    },
  },
  {
    files: ["__tests__/**/*.js"],
    rules: {
      "max-lines-per-function": "off",
      "no-magic-numbers": "off",
    },
  },
  {
    ignores: ["node_modules/", "coverage/"],
  },
];
