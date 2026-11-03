"use strict";

// One process-wide reservation for account JSON/NDJSON and build-order exports.
// Closing a socket cannot release work still cleaning up its actual readers.
/** @type {object|null} */ let activeExport = null;

/** @param {import('express').Response} res */
function reserveExport(res) {
  if (activeExport !== null) return null;
  const lease = {};
  activeExport = lease;
  let workSettled = false, terminal = false;
  const release = () => {
    if (!workSettled || !terminal || activeExport !== lease) return;
    activeExport = null;
    res.off("finish", ended); res.off("close", ended); res.off("error", ended);
  };
  const ended = () => { terminal = true; release(); };
  res.on("finish", ended); res.on("close", ended); res.on("error", ended);
  return {
    closed: () => terminal || res.destroyed || res.writableEnded,
    settle: () => { workSettled = true; release(); },
  };
}

/** @param {import('express').Response} res @param {AbortSignal} signal */
function waitForDrain(res, signal) {
  return new Promise((resolve, reject) => {
    const clean = () => { res.off("drain", ready); res.off("close", closed); signal.removeEventListener("abort", closed); };
    const ready = () => { clean(); resolve(undefined); };
    const closed = () => { clean(); reject(new Error("export_aborted")); };
    res.once("drain", ready); res.once("close", closed); signal.addEventListener("abort", closed, { once: true });
    if (signal.aborted || res.destroyed) closed();
  });
}

module.exports = { reserveExport, waitForDrain };
