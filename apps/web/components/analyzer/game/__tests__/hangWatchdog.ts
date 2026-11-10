// DIAGNOSTIC ONLY (temporary branch): prints the main thread's stack when it stops
// running timers, then kills the worker so the run can finish.
import fs from "node:fs";
import { Worker } from "node:worker_threads";

const WATCHDOG = `
const { workerData } = require("node:worker_threads");
const inspector = require("node:inspector");
const fs = require("node:fs");
const beat = new Float64Array(workerData.sab);
const session = new inspector.Session();
session.connectToMainThread();
let fired = 0;
setInterval(() => {
  const idle = Date.now() - beat[0];
  if (idle < 6000 || fired >= 4) return;
  fired += 1;
  const sample = fired;
  fs.writeSync(2, "\\n[diag watchdog] " + workerData.label + " main thread blocked " + idle + " ms, sample " + sample + ", rss " + Math.round(process.memoryUsage().rss / 1048576) + " MB\\n");
  session.post("Debugger.enable", () => {
    session.once("Debugger.paused", (message) => {
      const frames = message.params.callFrames.slice(0, 80).map((f) => "  at " + (f.functionName || "<anon>") + " " + f.url.split("/").slice(-4).join("/") + ":" + (f.location.lineNumber + 1) + ":" + (f.location.columnNumber + 1));
      fs.writeSync(2, "[diag watchdog] sample " + sample + " stack:\\n" + frames.join("\\n") + "\\n");
      session.post("Debugger.resume", () => {});
    });
    session.post("Debugger.pause", () => {});
  });
  if (fired >= 4) setTimeout(() => { fs.writeSync(2, "[diag watchdog] killing worker\\n"); process.kill(process.pid, "SIGKILL"); }, 5000);
}, 1500);
`;

let errors = 0;

export function diag(message: string) {
  try { fs.writeSync(2, `[diag] ${message}\n`); } catch { /* diagnostics only */ }
}

export function startHangWatchdog(label: string) {
  const sab = new SharedArrayBuffer(8);
  const beat = new Float64Array(sab);
  beat[0] = Date.now();
  const timer = setInterval(() => { beat[0] = Date.now(); }, 200);
  timer.unref?.();
  const worker = new Worker(WATCHDOG, { eval: true, workerData: { sab, label } });
  worker.unref();
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors += 1;
    if (errors <= 25 || errors % 2000 === 0) diag(`console.error #${errors}: ${args.map(String).join(" ").slice(0, 1200)}`);
    if (errors <= 25) original(...args);
  };
}
