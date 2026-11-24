"use strict";

/**
 * Tags the admin storage advisory's cluster-wide listDatabases and dbStats
 * commands. A failure on another application's database echoes that
 * database's name ("not authorized on <db> ..."), so the slow/failed-command
 * log treats these commands as private and records only a code.
 */
const STORAGE_TOTALS_COMMENT = "sc2tools-infra-storage-totals-v1";

module.exports = { STORAGE_TOTALS_COMMENT };
