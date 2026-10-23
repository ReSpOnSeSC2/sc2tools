// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import ts from "typescript";
it("uses US English in public copy", () => {
  const failures: string[] = [];
  const pattern = /\b(theatre|practis(e|ed|ing)|favour|licence|colour|behaviour)\b/i;
  for (const root of ["components/landing", "app/sign-in", "app/sign-up", "app/legal"]) {
    for (const entry of readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".tsx"))) {
      const file = path.join(root, String(entry)); const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function inspect(node: ts.Node) { if ((ts.isStringLiteral(node) || ts.isJsxText(node) || ts.isNoSubstitutionTemplateLiteral(node)) && pattern.test(node.text)) failures.push(`${file}: ${node.text.trim()}`); ts.forEachChild(node, inspect); }
      inspect(source);
    }
  }
  expect(failures).toEqual([]);
});
