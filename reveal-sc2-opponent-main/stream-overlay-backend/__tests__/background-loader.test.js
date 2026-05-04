"use strict";

// Background-loader: end-to-end smoke. Writes a JSON file to disk, then
// asserts the loader picks up changes via the worker and triggers
// onReloaded with a fresh revision. The signature helper is also
// covered (fast — no worker spawn).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bg = require("../lib/background-loader");

describe("fileSignature", () => {
  test("returns null for missing file", () => {
    expect(bg.fileSignature(path.join(os.tmpdir(), "no_such.json"))).toBeNull();
  });

  test("changes when content changes", () => {
    const tmp = path.join(os.tmpdir(), `sig-test-${process.pid}.json`);
    fs.writeFileSync(tmp, '{"a":1}');
    const a = bg.fileSignature(tmp);
    fs.writeFileSync(tmp, '{"a":2}');
    const b = bg.fileSignature(tmp);
    fs.unlinkSync(tmp);
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
  });
});

describe("startLoader", () => {
  test("loads a file in the background and bumps revision", async () => {
    const tmp = path.join(os.tmpdir(), `bg-load-${process.pid}.json`);
    fs.writeFileSync(tmp, '{"hello":"world"}');
    const slot = {
      data: {},
      signature: null,
      revision: 0,
      loadedAt: 0,
    };
    const reloaded = new Promise((resolve) => {
      const handle = bg.startLoader({
        filePath: tmp,
        slot,
        onReloaded: (info) => {
          handle.stop();
          resolve(info);
        },
        pollMs: 50,
      });
    });
    const info = await reloaded;
    fs.unlinkSync(tmp);
    expect(info.revision).toBe(1);
    expect(slot.data).toEqual({ hello: "world" });
    expect(slot.signature).not.toBeNull();
  }, 10000);

  test("does not re-trigger when signature hasn't changed", async () => {
    const tmp = path.join(os.tmpdir(), `bg-stable-${process.pid}.json`);
    fs.writeFileSync(tmp, '{"x":1}');
    const slot = { data: {}, signature: null, revision: 0, loadedAt: 0 };
    let count = 0;
    const handle = bg.startLoader({
      filePath: tmp,
      slot,
      onReloaded: () => {
        count += 1;
      },
      pollMs: 30,
    });
    await new Promise((r) => setTimeout(r, 250));
    handle.stop();
    fs.unlinkSync(tmp);
    expect(count).toBe(1);
  }, 10000);
});
