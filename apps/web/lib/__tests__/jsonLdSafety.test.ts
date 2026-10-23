import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

function filesUnder(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? filesUnder(file) : file.endsWith(".tsx") ? [file] : [];
  });
}

it("every JSON-LD script uses the HTML-safe serializer", () => {
  const failures: string[] = []; let scripts = 0;
  for (const file of ["app", "components"].flatMap(filesUnder)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(source) === "script") {
        const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
        const jsonLd = attrs.some((attr) => attr.name.getText(source) === "type" && attr.initializer && ts.isStringLiteral(attr.initializer) && attr.initializer.text === "application/ld+json");
        if (jsonLd) {
          scripts++;
          const html = attrs.find((attr) => attr.name.getText(source) === "dangerouslySetInnerHTML")?.getText(source) ?? "";
          if (!html.includes("serializeJsonLd(") || html.includes("JSON.stringify(")) failures.push(file);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(scripts).toBeGreaterThan(5);
  expect(failures).toEqual([]);
});
