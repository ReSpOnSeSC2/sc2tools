"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");

test("the flattened API runtime includes and loads the authored profile rules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sc2-overlay-runtime-"));
  try {
    const validator = path.join(root, "app/src/validation/overlayProfile.js"), rules = path.join(root, "web/lib/overlayProfileRules.json");
    fs.mkdirSync(path.dirname(validator), { recursive: true }); fs.mkdirSync(path.dirname(rules), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "../src/validation/overlayProfile.js"), validator);
    const dockerfile = fs.readFileSync(path.join(__dirname, "../Dockerfile"), "utf8");
    for (const file of ["overlayProfileRules.json", "overlayPresenceRules.json"]) {
      expect(dockerfile).toContain(`COPY apps/web/lib/${file} /web/lib/${file}`);
      fs.copyFileSync(path.join(__dirname, "../../web/lib", file), path.join(path.dirname(rules), file));
    }
    const output = execFileSync(process.execPath, ["-e", "const v=require(process.argv[1]); process.stdout.write(JSON.stringify(v.validateOverlayProfile({v:1,theme:{accent:'#ABC'},widgetOptions:{scouting:{durationSec:45}}})))", validator], { encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ v: 1, theme: { accent: "#abc" }, widgetOptions: { scouting: { durationSec: 45 } } });
  } finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("sc2-overlay-runtime-")) throw new Error("Unexpected runtime fixture path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
