"use strict";

const crypto = require("crypto");

const PEPPER_BYTES = 32;

console.log(crypto.randomBytes(PEPPER_BYTES).toString("hex"));
