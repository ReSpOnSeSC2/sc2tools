"use strict";

const { readFileSync } = require("node:fs");
const { summarizeBalance } = require("../src/services/pulseBalanceSummary");

function main() {
  const [, , filename, ...extra] = process.argv;
  if (!filename || extra.length) {
    throw new Error("Usage: node apps/api/scripts/preview-ladder-balance.js <normalized-json-file>");
  }
  const text = readFileSync(filename, "utf8");
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("Input is not valid JSON.");
  }
  process.stdout.write(`${JSON.stringify(summarizeBalance(input), null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
