// @ts-nocheck
"use strict";

/**
 * /v1/public/preview-replay route — body validation and runner-error tests.
 *
 * The CLI itself requires sc2reader + a real .SC2Replay file, so we
 * mock pythonAvailable() and runPythonNdjson() to drive the route's
 * branches without spawning Python.
 */

const request = require("supertest");
const pino = require("pino");
const express = require("express");

jest.mock("../src/util/pythonRunner", () => {
  const real = jest.requireActual("../src/util/pythonRunner");
  return {
    ...real,
    pythonAvailable: jest.fn(() => false),
    runPythonNdjson: jest.fn(async () => []),
  };
});

const pythonRunner = require("../src/util/pythonRunner");
const { buildPublicReplayRouter } = require("../src/routes/publicReplay");

function makeApp(logger) {
  const app = express();
  app.use(buildPublicReplayRouter({ logger }));
  // Final error handler so tests get a clean status, not a crash.
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({
      error: { code: err.code || "internal_error", message: err.message },
    });
  });
  return app;
}

describe("POST /public/preview-replay", () => {
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    pythonRunner.pythonAvailable.mockReturnValue(false);
    pythonRunner.runPythonNdjson.mockReset();
  });

  test("503 when the analyzer dir / Python isn't available", async () => {
    pythonRunner.pythonAvailable.mockReturnValue(false);
    const app = makeApp(logger);
    const res = await request(app)
      .post("/public/preview-replay")
      .set("content-type", "application/octet-stream")
      .send(Buffer.from([0x4d, 0x50, 0x51, 0x1a, 0x00, 0x00]));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("preview_unavailable");
  });

  test("400 on an empty body", async () => {
    pythonRunner.pythonAvailable.mockReturnValue(true);
    const app = makeApp(logger);
    const res = await request(app)
      .post("/public/preview-replay")
      .set("content-type", "application/octet-stream")
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("empty_body");
  });

  test("400 when the body doesn't start with the MPQ magic", async () => {
    pythonRunner.pythonAvailable.mockReturnValue(true);
    const app = makeApp(logger);
    const res = await request(app)
      .post("/public/preview-replay")
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("This is plainly not a replay.", "utf8"));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("not_a_replay");
  });

  test("accepts the MPQ user-data magic ('MPQ\\x1b') used by real SC2 replays", async () => {
    // Real .SC2Replay files start with MPQ\x1b (User Data Header), not
    // MPQ\x1a (Archive Header). Regression guard: the original check
    // rejected every real replay because it only matched \x1a.
    pythonRunner.pythonAvailable.mockReturnValue(true);
    pythonRunner.runPythonNdjson.mockResolvedValueOnce([
      {
        ok: true,
        game_id: "g2",
        map: "Real LE",
        duration_sec: 720,
        players: [
          { name: "a", race: "Zerg", build_log: ["[0:00] Hatchery"] },
          { name: "b", race: "Protoss", build_log: ["[0:00] Nexus"] },
        ],
      },
    ]);
    const mpq = Buffer.alloc(64);
    mpq.set([0x4d, 0x50, 0x51, 0x1b]);
    const app = makeApp(logger);
    const res = await request(app)
      .post("/public/preview-replay")
      .set("content-type", "application/octet-stream")
      .send(mpq);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.map).toBe("Real LE");
  });

  test("forwards the parsed dossier when the CLI succeeds", async () => {
    pythonRunner.pythonAvailable.mockReturnValue(true);
    pythonRunner.runPythonNdjson.mockResolvedValueOnce([
      {
        ok: true,
        game_id: "g1",
        map: "Test LE",
        duration_sec: 600,
        players: [
          { name: "p1", race: "Protoss", build_log: ["[0:00] Nexus"] },
          { name: "p2", race: "Terran", build_log: ["[0:00] CommandCenter"] },
        ],
      },
    ]);
    const mpq = Buffer.alloc(64);
    mpq.set([0x4d, 0x50, 0x51, 0x1a]);
    const app = makeApp(logger);
    const res = await request(app)
      .post("/public/preview-replay")
      .set("content-type", "application/octet-stream")
      .send(mpq);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.players).toHaveLength(2);
    expect(res.body.map).toBe("Test LE");
  });

  test("422 when the CLI emits a structured failure (e.g. AI replay)", async () => {
    pythonRunner.pythonAvailable.mockReturnValue(true);
    pythonRunner.runPythonNdjson.mockResolvedValueOnce([
      {
        ok: false,
        code: "no_two_humans",
        message: "this demo only handles 1v1 replays with two human players.",
      },
    ]);
    const mpq = Buffer.alloc(64);
    mpq.set([0x4d, 0x50, 0x51, 0x1a]);
    const app = makeApp(logger);
    const res = await request(app)
      .post("/public/preview-replay")
      .set("content-type", "application/octet-stream")
      .send(mpq);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("no_two_humans");
  });

  test("422 forwards replay_too_new from the CLI when sc2reader can't read a newer SC2 patch", async () => {
    pythonRunner.pythonAvailable.mockReturnValue(true);
    pythonRunner.runPythonNdjson.mockResolvedValueOnce([
      {
        ok: false,
        code: "replay_too_new",
        message:
          "sc2reader load failed: ord() expected a character, but string of length 0 found",
      },
    ]);
    const mpq = Buffer.alloc(64);
    mpq.set([0x4d, 0x50, 0x51, 0x1b]);
    const app = makeApp(logger);
    const res = await request(app)
      .post("/public/preview-replay")
      .set("content-type", "application/octet-stream")
      .send(mpq);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("replay_too_new");
  });

  test("502 with mapped code when the Python runner raises a timeout PythonError", async () => {
    pythonRunner.pythonAvailable.mockReturnValue(true);
    const { PythonError } = jest.requireActual("../src/util/pythonRunner");
    pythonRunner.runPythonNdjson.mockImplementationOnce(() => {
      throw new PythonError("python_timeout", { kind: "timeout" });
    });
    const mpq = Buffer.alloc(64);
    mpq.set([0x4d, 0x50, 0x51, 0x1b]);
    const app = makeApp(logger);
    const res = await request(app)
      .post("/public/preview-replay")
      .set("content-type", "application/octet-stream")
      .send(mpq);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("preview_timeout");
  });

  test("502 with python_error when the Python process exits non-zero with no records", async () => {
    pythonRunner.pythonAvailable.mockReturnValue(true);
    const { PythonError } = jest.requireActual("../src/util/pythonRunner");
    pythonRunner.runPythonNdjson.mockImplementationOnce(() => {
      throw new PythonError("python_exit_1", {
        kind: "exit_nonzero",
        exitCode: 1,
        stderr: "",
      });
    });
    const mpq = Buffer.alloc(64);
    mpq.set([0x4d, 0x50, 0x51, 0x1b]);
    const app = makeApp(logger);
    const res = await request(app)
      .post("/public/preview-replay")
      .set("content-type", "application/octet-stream")
      .send(mpq);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("python_error");
  });

  test("502 with preview_unavailable when the Python spawn itself fails", async () => {
    pythonRunner.pythonAvailable.mockReturnValue(true);
    const { PythonError } = jest.requireActual("../src/util/pythonRunner");
    pythonRunner.runPythonNdjson.mockImplementationOnce(() => {
      throw new PythonError("ENOENT: no such file or directory", {
        kind: "spawn_error",
      });
    });
    const mpq = Buffer.alloc(64);
    mpq.set([0x4d, 0x50, 0x51, 0x1b]);
    const app = makeApp(logger);
    const res = await request(app)
      .post("/public/preview-replay")
      .set("content-type", "application/octet-stream")
      .send(mpq);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("preview_unavailable");
  });
});
