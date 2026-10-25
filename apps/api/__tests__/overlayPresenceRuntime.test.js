"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { KNOWN_WIDGETS } = require("../src/services/overlayTokens");
test("the flattened API image loads the shared source rules at their real relative path", () => {
  const api = path.resolve(__dirname, "..");
  expect(fs.readFileSync(path.join(api, "Dockerfile"), "utf8")).toMatch(/^COPY apps\/web\/lib\/overlayPresenceRules\.json \/web\/lib\/overlayPresenceRules\.json$/m);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sc2tools-presence-runtime-"));
  const service = path.join(root, "app/src/services/overlayPresence.js"), registry = path.join(root, "app/src/services/overlayTokens.js"), fixture = path.join(root, "web/lib/overlayPresenceRules.json");
  try {
    fs.mkdirSync(path.dirname(service), { recursive: true }); fs.mkdirSync(path.dirname(fixture), { recursive: true });
    fs.copyFileSync(path.join(api, "src/services/overlayPresence.js"), service);
    // All API services are already copied by Docker; isolate only this
    // registry dependency so the test checks the shared asset's runtime path.
    fs.writeFileSync(registry, `module.exports = { KNOWN_WIDGETS: ${JSON.stringify(KNOWN_WIDGETS)} };`);
    fs.copyFileSync(path.join(api, "../web/lib/overlayPresenceRules.json"), fixture);
    const { overlayDescriptor } = require(service);
    expect(overlayDescriptor({ surface: "scene", widget: "brb" })).toEqual({ surface: "scene", widget: "brb" });
    expect(overlayDescriptor({ surface: "widget", widget: "ghost-build" })).toEqual({ surface: "widget", widget: "ghost-build" });
  } finally {
    for (const file of [service, registry, fixture]) if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const dir of ["app/src/services", "app/src", "app", "web/lib", "web", ""]) fs.rmdirSync(path.join(root, dir));
  }
});
