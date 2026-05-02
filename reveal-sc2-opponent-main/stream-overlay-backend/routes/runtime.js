/**
 * RUNTIME ROUTER (Stage 1.4)
 * ============================================================
 * Endpoints for managing the long-lived helper processes that aren't
 * children of this Node backend (the SC2Pulse PowerShell poller spawned
 * by the user's launcher cmd window).
 *
 * Endpoints
 * ---------
 *   POST /api/runtime/restart-poller
 *       -> { ok, pid?, started: bool, error? }
 *       Spawns a fresh ``scripts/poller_launch.py`` process so the new
 *       PowerShell window picks up whatever identity the user just
 *       saved in Settings -> Profile. We don't kill the old PowerShell
 *       window -- it lives in a different console owned by the user --
 *       so the SPA tells the user to close that window manually.
 *
 *   GET /api/runtime/status
 *       -> { ok, watcher_hot_reload_sec, can_restart_poller }
 *       Lightweight status payload the SPA uses to decide which
 *       runtime-control affordances to render.
 *
 * Why this lives outside the existing routers
 * -------------------------------------------
 * The launcher children (watcher, poller) are spawned by either
 * ``START_SC2_TOOLS.bat`` (separate cmd windows) or
 * ``SC2ReplayAnalyzer.py`` (subprocess.Popen children). Neither path
 * makes them children of this Node backend, so settings.js / onboarding.js
 * can't manage them. This router is the seam where the SPA reaches out
 * and asks the OS to spawn a fresh poller; the watcher hot-reloads
 * config.json on its own (see watchers/replay_watcher.py).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { spawn } = require('child_process');

function pickPythonExe() {
    if (process.env.PYTHON) return process.env.PYTHON;
    return process.platform === 'win32' ? 'py' : 'python3';
}

/**
 * Build the runtime router.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot   Absolute path to reveal-sc2-opponent-main.
 * @param {string} [opts.pythonExe] Python launcher to use (defaults to
 *                                  PYTHON env or platform default).
 */
function createRuntimeRouter(opts) {
    const router = express.Router();
    const repoRoot = opts && opts.repoRoot;
    const pythonExe = (opts && opts.pythonExe) || pickPythonExe();
    const pollerScript = path.join(repoRoot, 'scripts', 'poller_launch.py');

    router.get('/api/runtime/status', (_req, res) => {
        res.json({
            ok: true,
            watcher_hot_reload_sec: 5,
            can_restart_poller: fs.existsSync(pollerScript),
        });
    });

    router.post('/api/runtime/restart-poller', (req, res) => {
        if (!fs.existsSync(pollerScript)) {
            return res.status(500).json({
                ok: false,
                error: `poller_launch.py not found at ${pollerScript}`,
            });
        }
        // Spawn detached so the new poller's lifetime isn't tied to
        // this HTTP request (the PS1 it kicks off lives inside its own
        // console). We don't await the child; we just return its pid
        // so the SPA can show "started pid=N".
        let proc;
        try {
            proc = spawn(pythonExe, [pollerScript], {
                cwd: repoRoot,
                detached: true,
                stdio: 'ignore',
                windowsHide: false,
            });
            proc.unref();
        } catch (err) {
            return res.status(500).json({
                ok: false,
                error: `failed to spawn poller_launch.py: ${err.message}`,
            });
        }
        console.log(`[runtime] restart-poller spawned pid=${proc.pid}`);
        res.json({ ok: true, started: true, pid: proc.pid });
    });

    return router;
}

module.exports = { createRuntimeRouter };
