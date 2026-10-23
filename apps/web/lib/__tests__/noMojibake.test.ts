import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}
it("keeps readable Unicode in application source", () => {
  const bad = /\u00e2\u20ac|\u00c3\u00a2|\ufffd/;
  const hits = ["app", "components", "lib"].flatMap((dir) => sources(path.join(root, dir)))
    .flatMap((file) => readFileSync(file, "utf8").split("\n").flatMap((line, index) =>
      bad.test(line) ? [`${path.relative(root, file).split(path.sep).join("/")}:${index + 1}`] : []));
  expect(hits).toEqual([]);
});
