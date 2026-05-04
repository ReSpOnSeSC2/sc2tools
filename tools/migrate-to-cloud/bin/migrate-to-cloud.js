#!/usr/bin/env node
"use strict";

require("../src/cli").main(process.argv.slice(2)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
