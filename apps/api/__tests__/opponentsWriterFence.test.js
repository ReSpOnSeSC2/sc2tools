// @ts-nocheck
"use strict";
// Every in-process write to the opponents collection runs inside the owner's UserRevision fence, so the write retires
// that owner's retained opponent-MMR bodies (ADR 0072, G1). Lexical scans over apps/api/src cover direct calls, split
// lines included, and the dynamic handles of restore and erasure. Inventories are exact: a new writer fails until fenced.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "src");
const WRITE = /\bopponents\s*\.\s*(?:updateOne|updateMany|insertOne|insertMany|bulkWrite|deleteOne|deleteMany|findOneAndUpdate|findOneAndDelete|findOneAndReplace|replaceOne)\s*\(/g;
const FENCE = "gameWrite(this.userRevision, userId, () => this.db.opponents.";
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(path.join(dir, entry.name)) : entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : []);
const sources = files(SRC).map(file => ({ file: path.relative(SRC, file).replaceAll("\\", "/"), text: fs.readFileSync(file, "utf8") }));
const sites = sources.flatMap(({ file, text }) => [...text.matchAll(WRITE)].map(match => {
  const line = text.slice(0, match.index).split("\n").length;
  return { file, line, text: text.split("\n")[line - 1].trim() };
}));
const count = list => list.reduce((counts, site) => ({ ...counts, [site.file]: (counts[site.file] || 0) + 1 }), {});

test("every in-process opponents write carries the owner's fence, and the inventory is exact", () => {
  const inProcess = sites.filter(site => !site.file.startsWith("db/migrations/"));
  expect(inProcess.filter(site => !site.text.includes(FENCE))).toEqual([]);
  expect(count(inProcess)).toEqual({ "services/gdpr.js": 4, "services/opponents.js": 9 });
});

test("the only other direct writer is the out-of-band migration, and the one collection alias only reads", () => {
  expect(Object.keys(count(sites.filter(site => site.file.startsWith("db/migrations/")))))
    .toEqual(["db/migrations/2026-05-12-heal-opponent-current-name.js"]);
  const aliases = sources.filter(({ file, text }) => !file.startsWith("db/") && /=\s*[\w.]*\bdb\.opponents\s*;/.test(text)).map(({ file }) => file);
  expect(aliases).toEqual(["jobs/pulseBackfillJob.js"]);
  const job = sources.find(({ file }) => file === "jobs/pulseBackfillJob.js").text;
  // The collection variable, not the injected service (`deps.opponents.backfill...`).
  expect([...job.matchAll(/(?<![\w.])opponents\s*\.\s*(\w+)\s*\(/g)].map(match => match[1])).toEqual(["aggregate", "aggregate"]);
});

// Snapshot restore and account erasure write whole collections through `(this.db)[key]` handles that the direct scan
// cannot see. A loop over USER_SCOPED_COLLECTIONS or RESTORABLE that writes must pass the shared chart-input fence, which
// selects the owner's fence for games and opponents. Every other dynamic handle is counted, and its key list never names
// opponents.
const inProcessSources = sources.filter(({ file }) => !file.startsWith("db/migrations/"));
const LOOP = /for\s*\(\s*const\s*\[[^\]]*\]\s+of\s+(USER_SCOPED_COLLECTIONS|RESTORABLE)\s*\)\s*\{/g;
const DYNAMIC_WRITE = /\.\s*(?:updateOne|updateMany|insertOne|insertMany|bulkWrite|deleteOne|deleteMany|findOneAndUpdate|findOneAndDelete|findOneAndReplace|replaceOne)\s*\(/;
const CHART_FENCE = /gameWrite\(chartInputFence\(this\.userRevision, \w+\), userId,/;
const block = (text, open) => {
  for (let i = open, depth = 0; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}" && (depth -= 1) === 0) return text.slice(open, i + 1);
  }
  throw new Error("unbalanced loop body");
};

test("every collection-list loop that writes passes the chart-input fence, which fences games and opponents", () => {
  const loops = inProcessSources.flatMap(({ file, text }) => [...text.matchAll(LOOP)].map(match => {
    const body = block(text, match.index + match[0].length - 1);
    return `${file} ${match[1]} ${!DYNAMIC_WRITE.test(body) ? "reads" : CHART_FENCE.test(body) ? "fenced" : "UNFENCED"}`;
  })).sort();
  expect(loops).toEqual(["services/accountExportData.js USER_SCOPED_COLLECTIONS reads", "services/gdpr.js USER_SCOPED_COLLECTIONS fenced",
    "services/userBackups.js RESTORABLE fenced", "services/userBackups.js RESTORABLE reads"]);
  const { chartInputFence } = require("../src/services/gdpr");
  const revisions = {};
  expect(["games", "opponents", "opponentNotes", "customBuilds", "profiles", "users"].map(key => chartInputFence(revisions, key) === revisions))
    .toEqual([true, true, false, false, false, false]);
  // Any other use of the two lists is a new reader or writer to review here.
  const uses = inProcessSources.flatMap(({ file, text }) => text.split("\n").filter(line => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .flatMap(line => [...line.matchAll(/\b(?:USER_SCOPED_COLLECTIONS|RESTORABLE)\b/g)].map(() => ({ file }))));
  expect(count(uses)).toEqual({ "services/accountExportData.js": 2, "services/accountExportPolicy.js": 2, "services/gdpr.js": 3, "services/userBackups.js": 8 });
});

test("the other dynamic collection handles are counted, and the key lists behind the writing ones never name opponents", () => {
  const handles = inProcessSources.flatMap(({ file, text }) => [...text.matchAll(/\(\s*(?:this\.)?db\s*\)\s*\[/g)].map(() => ({ file })));
  expect(count(handles)).toEqual({ "services/dataInventory.js": 2, "services/gdpr.js": 2, "services/gdprOwnedData.js": 1,
    "services/overlayTokenRotation.js": 1, "services/userBackups.js": 2 });
  for (const [file, name] of [["services/gdpr.js", "PURGE_ONLY_COLLECTIONS"], ["services/gdprOwnedData.js", "TOKEN_COLLECTIONS"],
    ["services/overlayTokenRotation.js", "ENGAGEMENT"]]) {
    const text = sources.find(source => source.file === file).text, start = text.indexOf(`const ${name} = [`);
    expect([name, start >= 0, /["']opponents["']/.test(text.slice(start, text.indexOf("];", start)))]).toEqual([name, true, false]);
  }
});

const astNodes = (root, keep) => {
  const found = []; const visit = node => { if (keep(node)) found.push(node); ts.forEachChild(node, visit); }; visit(root); return found;
};
const unparen = node => { while (node && ts.isParenthesizedExpression(node)) node = node.expression; return node; };
const id = (node, name) => !!node && ts.isIdentifier(node) && node.text === name;
const calls = fn => astNodes(fn.body, ts.isCallExpression).map(call => call.expression.getText());

test("delegated account-export dynamic handles are exactly guarded reads with awaited cursor cleanup and no escape", () => {
  const text = sources.find(source => source.file === "services/accountExportData.js").text;
  const sf = ts.createSourceFile("accountExportData.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  expect(sf.parseDiagnostics).toEqual([]);
  const named = name => astNodes(sf, node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  const records = named("collectionRecords"), exports = named("exportRows"); expect(records).toHaveLength(1); expect(exports).toHaveLength(1);
  const [recordFn] = records, [exportFn] = exports;
  expect(recordFn.parameters.map(parameter => parameter.name.getText())).toEqual(["db", "name", "filter", "projection", "signal", "redact"]);
  expect(exportFn.parameters.map(parameter => parameter.name.getText())).toEqual(["collection", "filter", "projection", "signal"]);
  for (const fn of [recordFn, exportFn]) {
    expect(Boolean(fn.asteriskToken) && fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)).toBe(true);
    expect(fn.body.statements).toHaveLength(4);
  }
  // The former inline read now delegates. Count both bare handles that the older `(db)[key]` scan cannot see.
  const handles = astNodes(sf, node => ts.isElementAccessExpression(node) && ["db", "this.db"].includes(unparen(node.expression).getText()));
  expect(handles.map(handle => [ts.findAncestor(handle, ts.isFunctionDeclaration)?.name?.text, handle.getText()]))
    .toEqual([["collectionRecords", "db[name]"], ["collectionRecords", "db[name]"]]);
  const [guard, handoff] = handles, condition = guard.parent;
  expect(ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken).toBe(true);
  expect(ts.isIfStatement(condition.parent) && condition.parent.expression === condition && ts.isReturnStatement(condition.parent.thenStatement)
    && !condition.parent.thenStatement.expression && !condition.parent.elseStatement).toBe(true);
  const delegated = handoff.parent;
  expect(ts.isCallExpression(delegated) && id(delegated.expression, "exportRows") && delegated.arguments[0] === handoff).toBe(true);
  expect(delegated.arguments.slice(1).map(argument => argument.getText())).toEqual(["filter", "projection", "signal"]);
  expect(ts.isForOfStatement(delegated.parent) && Boolean(delegated.parent.awaitModifier) && delegated.parent.expression === delegated).toBe(true);
  const dbReferences = astNodes(recordFn.body, node => id(node, "db"));
  expect(dbReferences.map(reference => reference.parent)).toEqual(handles);
  expect(calls(recordFn)).toEqual(["checkExportSignal", "exportRows", "redact"]);
  const collectionReferences = astNodes(exportFn.body, node => id(node, "collection")); expect(collectionReferences).toHaveLength(1);
  const receiver = collectionReferences[0].parent;
  expect(ts.isPropertyAccessExpression(receiver) && receiver.expression === collectionReferences[0] && receiver.name.text === "find").toBe(true);
  const find = receiver.parent; expect(ts.isCallExpression(find) && find.expression === receiver).toBe(true);
  expect(find.arguments.map(argument => argument.getText())).toEqual(["filter", "{ projection, batchSize: 1, signal }"]);
  const declaration = find.parent; expect(ts.isVariableDeclaration(declaration) && id(declaration.name, "cursor") && declaration.initializer === find).toBe(true);
  expect(declaration.parent.flags & ts.NodeFlags.Const).toBe(ts.NodeFlags.Const);
  const iterations = astNodes(exportFn.body, ts.isForOfStatement); expect(iterations).toHaveLength(1);
  expect(Boolean(iterations[0].awaitModifier) && id(iterations[0].expression, "cursor")).toBe(true);
  const close = astNodes(exportFn.body, node => ts.isCallExpression(node) && node.expression.getText() === "cursor.close"); expect(close).toHaveLength(1);
  expect(ts.isAwaitExpression(close[0].parent) && close[0].parent.expression === close[0] && close[0].arguments.length === 0).toBe(true);
  const cleanup = astNodes(exportFn.body, ts.isTryStatement); expect(cleanup).toHaveLength(1);
  expect(cleanup[0].finallyBlock?.statements).toHaveLength(1);
  expect(cleanup[0].finallyBlock.statements[0].expression).toBe(close[0].parent);
  const cursorReferences = astNodes(exportFn.body, node => id(node, "cursor") && node !== declaration.name);
  expect(cursorReferences).toEqual([iterations[0].expression, close[0].expression.expression]);
  expect(calls(exportFn)).toEqual(["checkExportSignal", "collection.find", "checkExportSignal", "checkExportSignal", "cursor.close", "checkExportSignal"]);
});
