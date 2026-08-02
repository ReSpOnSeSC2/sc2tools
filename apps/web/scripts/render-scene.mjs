#!/usr/bin/env node
/**
 * render-scene.mjs — offline export of the backdrop scenes.
 *
 * Produces a 4K still and (when ffmpeg is available) a seamlessly
 * looping MP4, for streamers who would rather drop an Image or Media
 * source into OBS than run a live Browser Source: no CPU at stream
 * time, and it works with the machine offline.
 *
 * The loop is seamless because every animation in SC2BackdropScene
 * has a duration that divides LOOP_SEC exactly, so frame 0 and frame
 * N are the same picture. That invariant is enforced by a unit test —
 * if someone adds a 7s animation, the test fails before this script
 * would silently start producing a visible jump.
 *
 * This is a manual local tool, deliberately NOT wired into CI: it
 * needs a built app and an ffmpeg binary, neither of which is worth
 * making the web pipeline depend on.
 *
 *   npm run build && npm start &
 *   node scripts/render-scene.mjs --scene between-games
 *
 * Options:
 *   --scene <id>     between-games | starting-soon | brb | intermission
 *   --base <url>     server origin (default http://localhost:3000)
 *   --token <t>      overlay token to render (default "dev")
 *   --out <dir>      output directory (default public/scenes)
 *   --fps <n>        loop frame rate (default 24)
 *   --still-only     skip the MP4
 */

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const execFileAsync = promisify(execFile);

/** Must match LOOP_SEC in components/overlay/scenes/SC2BackdropScene.tsx. */
const LOOP_SEC = 20;

const VALID_SCENES = new Set([
  "between-games",
  "starting-soon",
  "brb",
  "intermission",
]);

function parseArgs(argv) {
  const args = {
    scene: "between-games",
    base: "http://localhost:3000",
    token: "dev",
    out: path.join(process.cwd(), "public", "scenes"),
    fps: 24,
    stillOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--still-only") {
      args.stillOnly = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) continue;
    if (flag === "--scene") args.scene = value;
    else if (flag === "--base") args.base = value;
    else if (flag === "--token") args.token = value;
    else if (flag === "--out") args.out = path.resolve(value);
    else if (flag === "--fps") args.fps = Number(value);
    else continue;
    i += 1;
  }
  return args;
}

async function hasFfmpeg() {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Playwright's bundled Chromium may not be downloaded in every
 * environment. Fall back to a system/prebuilt binary when one is
 * pointed at by PLAYWRIGHT_CHROMIUM_EXECUTABLE, rather than telling
 * the user to run `playwright install`.
 *
 * RENDER_SCENE_CHROMIUM_ARGS is a space-separated passthrough for the
 * awkward cases — a corporate proxy that intercepts loopback, for
 * instance, usually wants --no-proxy-server here.
 */
function launchOptions() {
  const opts = {};
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (exe) opts.executablePath = exe;
  const extra = (process.env.RENDER_SCENE_CHROMIUM_ARGS || "").trim();
  if (extra) opts.args = extra.split(/\s+/);
  return opts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!VALID_SCENES.has(args.scene)) {
    console.error(
      `Unknown scene "${args.scene}". Valid: ${[...VALID_SCENES].join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  await mkdir(args.out, { recursive: true });
  const sceneUrl = (extra) =>
    `${args.base.replace(/\/$/, "")}/overlay/${args.token}/scene/${args.scene}?demo=1${extra}`;

  const browser = await chromium.launch(launchOptions());
  try {
    // ---- 4K still ----
    const stillPage = await browser.newPage({
      viewport: { width: 3840, height: 2160 },
      deviceScaleFactor: 1,
      // Rendering our own dev server; a cert complaint here is never a
      // real trust decision, just an intercepting local proxy.
      ignoreHTTPSErrors: true,
    });
    await stillPage.goto(sceneUrl("&static=1"), { waitUntil: "networkidle" });
    const stillPath = path.join(args.out, `${args.scene}-4k.png`);
    await stillPage.screenshot({ path: stillPath });
    await stillPage.close();
    console.log(`still  → ${stillPath}`);

    if (args.stillOnly) return;
    if (!(await hasFfmpeg())) {
      console.warn(
        "ffmpeg not found on PATH — skipping the MP4. The still above " +
          "is still usable as an OBS Image source.",
      );
      return;
    }

    // ---- one full animation cycle ----
    const frameDir = path.join(args.out, `.frames-${args.scene}`);
    await rm(frameDir, { recursive: true, force: true });
    await mkdir(frameDir, { recursive: true });

    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
    });
    await page.goto(sceneUrl(""), { waitUntil: "networkidle" });

    const total = Math.round(LOOP_SEC * args.fps);
    // Drive the clock rather than sleeping in real time: Chromium's
    // animation timeline is deterministic under setTime, so the frames
    // land exactly on the cycle instead of drifting with render load.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Animation.enable");
    for (let frame = 0; frame < total; frame += 1) {
      const tMs = (frame / args.fps) * 1000;
      await cdp.send("Animation.setCurrentTime", { currentTime: tMs }).catch(
        () => {},
      );
      await page.evaluate(
        (t) => {
          for (const anim of document.getAnimations()) {
            anim.pause();
            anim.currentTime = t;
          }
        },
        tMs,
      );
      await page.screenshot({
        path: path.join(
          frameDir,
          `frame${String(frame).padStart(5, "0")}.png`,
        ),
      });
    }
    await page.close();

    const mp4Path = path.join(args.out, `${args.scene}-loop.mp4`);
    await execFileAsync("ffmpeg", [
      "-y",
      "-framerate",
      String(args.fps),
      "-i",
      path.join(frameDir, "frame%05d.png"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "18",
      mp4Path,
    ]);
    await rm(frameDir, { recursive: true, force: true });
    console.log(`loop   → ${mp4Path} (${LOOP_SEC}s, ${args.fps}fps)`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
