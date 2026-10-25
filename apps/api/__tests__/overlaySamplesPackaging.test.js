"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

test("the API runtime image includes and loads the shared browser sample fixture", () => {
  const api = path.resolve(__dirname, "..");
  const docker = fs.readFileSync(path.join(api, "Dockerfile"), "utf8");
  expect(docker).toMatch(/^COPY apps\/web\/lib\/overlaySamples\.json \/web\/lib\/overlaySamples\.json$/m);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sc2tools-sample-layout-"));
  const service = path.join(root, "app/src/services/overlayLiveSamples.js"), fixture = path.join(root, "web/lib/overlaySamples.json");
  try {
    fs.mkdirSync(path.dirname(service), { recursive: true }); fs.mkdirSync(path.dirname(fixture), { recursive: true });
    fs.copyFileSync(path.join(api, "src/services/overlayLiveSamples.js"), service);
    fs.copyFileSync(path.join(api, "../web/lib/overlaySamples.json"), fixture);
    const { buildSamplePayload } = require(service);
    expect(buildSamplePayload("opponent")).toMatchObject({ oppName: "TestOpponent" });
    expect(() => buildSamplePayload("__proto__")).not.toThrow();
  } finally {
    for (const file of [service, fixture]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const dir of ["app/src/services", "app/src", "app", "web/lib", "web", ""]) fs.rmdirSync(path.join(root, dir));
  }
});
