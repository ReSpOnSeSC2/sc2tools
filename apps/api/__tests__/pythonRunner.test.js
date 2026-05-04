// @ts-nocheck
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  runPythonNdjson,
  spawnPythonNdjson,
  writeTempFile,
  pickPythonExe,
  resolveProjectDir,
  pythonAvailable,
  PythonError,
} = require("../src/util/pythonRunner");

describe("util/pythonRunner", () => {
  test("writeTempFile writes contents and returns the path", () => {
    const p = writeTempFile("test", "txt", "hello");
    try {
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.readFileSync(p, "utf8")).toBe("hello");
    } finally {
      fs.unlinkSync(p);
    }
  });

  test("pickPythonExe honours the env override", () => {
    const original = process.env.SC2_PY_PYTHON;
    process.env.SC2_PY_PYTHON = "/custom/python";
    try {
      expect(pickPythonExe()).toBe("/custom/python");
    } finally {
      if (original === undefined) delete process.env.SC2_PY_PYTHON;
      else process.env.SC2_PY_PYTHON = original;
    }
  });

  test("resolveProjectDir returns null when nothing is configured", () => {
    const original = process.env.SC2_PY_ANALYZER_DIR;
    process.env.SC2_PY_ANALYZER_DIR = "/tmp/__definitely_missing__";
    try {
      expect(resolveProjectDir()).toBeNull();
      expect(pythonAvailable()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.SC2_PY_ANALYZER_DIR;
      else process.env.SC2_PY_ANALYZER_DIR = original;
    }
  });

  test("resolveProjectDir uses the env var when it exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc2py-"));
    const original = process.env.SC2_PY_ANALYZER_DIR;
    process.env.SC2_PY_ANALYZER_DIR = tmp;
    try {
      expect(resolveProjectDir()).toBe(tmp);
      expect(pythonAvailable()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.SC2_PY_ANALYZER_DIR;
      else process.env.SC2_PY_ANALYZER_DIR = original;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runPythonNdjson rejects with PythonError when project dir is missing", async () => {
    const original = process.env.SC2_PY_ANALYZER_DIR;
    process.env.SC2_PY_ANALYZER_DIR = "/tmp/__definitely_missing__";
    try {
      await expect(
        runPythonNdjson({ script: "x.py" }),
      ).rejects.toBeInstanceOf(PythonError);
    } finally {
      if (original === undefined) delete process.env.SC2_PY_ANALYZER_DIR;
      else process.env.SC2_PY_ANALYZER_DIR = original;
    }
  });

  test("spawnPythonNdjson reports closure with exitCode -1 when project dir missing", () => {
    const original = process.env.SC2_PY_ANALYZER_DIR;
    process.env.SC2_PY_ANALYZER_DIR = "/tmp/__definitely_missing__";
    return new Promise((resolve) => {
      spawnPythonNdjson({
        script: "x.py",
        onRecord: () => {},
        onClose: ({ exitCode }) => {
          if (original === undefined) delete process.env.SC2_PY_ANALYZER_DIR;
          else process.env.SC2_PY_ANALYZER_DIR = original;
          expect(exitCode).toBe(-1);
          resolve(undefined);
        },
      });
    });
  });
});
