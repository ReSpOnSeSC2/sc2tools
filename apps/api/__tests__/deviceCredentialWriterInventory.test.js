// @ts-nocheck
"use strict";

// Device-credential writer inventory for ADR 0072
// (docs/adr/0072-serving-cohort-coherence.md). Authority writers (issue,
// revoke-hash, revoke-id, erase) may dispatch only inside the durable credential
// coordinator; metadata writers (touch, label, heartbeat, connection marker) may
// not write a field that device authentication reads. A new reference, writer or
// hand-off fails here until the ADR's actor table and these lists change together.
//
// Named limitations (ADR 0072): this is lexical source evidence, not a runtime,
// failover, clock or separate-process proof. It cannot see manual edits, raw
// restores or code outside apps/api, and it recognises the erase loop's dynamic
// collection access by name rather than by data flow.

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const API = path.join(__dirname, "..");
const PAIRINGS = "src/services/devicePairings.js";
const TOKEN_READ = "src/services/deviceAuthTokenRead.js";
const GDPR = "src/services/gdpr.js";
const BACKUPS = "src/services/userBackups.js";
const MUTATIONS = new Set(["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne",
  "deleteMany", "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete", "bulkWrite", "drop", "rename"]);
const AUTH_FIELDS = ["tokenHash", "revokedAt", "userId", "_id"];
const METADATA_FIELDS = new Set(["lastSeenAt", "label", "connectedEventRecordedAt",
  "agentVersion", "agentOs", "agentOsRelease", "hostname"]);

// Every file under src/ and scripts/ that names the collection, and why.
const REFERENCES = {
  "scripts/relink-clerk-user.js": "read",
  "src/config/constants.js": "definition",
  "src/db/connect.js": "definition",
  "src/db/schemaVersioning.js": "definition",
  "src/services/admin.js": "read",
  "src/services/adminActivation.js": "read",
  "src/services/adminEvents.js": "read",
  "src/services/adminUsers.js": "read",
  "src/services/coaching.js": "read",
  "src/services/dataInventory.js": "read",
  [PAIRINGS]: "writer",
  [GDPR]: "erase and export",
  "src/services/siteStats.js": "read",
  [BACKUPS]: "restore exclusion",
};
// ADR 0072 actor table, minus erase (a dynamic loop, checked separately).
const WRITERS = [
  { role: "issue", file: PAIRINGS, fn: "#insertIssuedToken", method: "insertOne", kind: null, authority: true },
  { role: "revoke-hash", file: PAIRINGS, fn: "revoke", method: "updateOne", kind: "revoke-hash", authority: true },
  { role: "revoke-id", file: PAIRINGS, fn: "revokeById", method: "updateOne", kind: "revoke-id", authority: true },
  { role: "label", file: PAIRINGS, fn: "setLabel", method: "updateOne", kind: null, authority: false },
  { role: "heartbeat", file: PAIRINGS, fn: "recordHeartbeat", method: "findOneAndUpdate", kind: null, authority: false },
  { role: "connection marker", file: PAIRINGS, fn: "recordHeartbeat", method: "updateOne", kind: null, authority: false },
  { role: "touch", file: TOKEN_READ, fn: "readDeviceTokenCore", method: "updateOne", kind: null, authority: false },
];
// Calls that pass the collection itself to a helper in TOKEN_READ.
const HANDOFFS = [`${PAIRINGS} readDeviceAuthSnapshot`, `${PAIRINGS} readDeviceTokenCore`];

const parsed = new Map();
function parse(rel) {
  if (!parsed.has(rel)) {
    const text = fs.readFileSync(path.join(API, rel), "utf8");
    parsed.set(rel, ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  }
  return parsed.get(rel);
}

function sourceFiles(dir) {
  return fs.readdirSync(path.join(API, dir), { withFileTypes: true }).flatMap(entry => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.[cm]?js$/.test(entry.name) ? [rel] : [];
  });
}

function nodes(root, keep) {
  const found = [];
  const visit = node => { if (keep(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return found;
}

const callName = call => ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : call.expression.getText();
const isMutation = node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
  && MUTATIONS.has(node.expression.name.text);

function namesCollection(node) {
  if (ts.isIdentifier(node)) return node.text === "deviceTokens" || node.text === "DEVICE_TOKENS";
  return ts.isStringLiteralLike(node) && (node.text === "deviceTokens" || node.text === "device_tokens");
}

function isTokenCollection(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "deviceTokens";
  if (!ts.isCallExpression(node) || callName(node) !== "collection" || node.arguments.length !== 1) return false;
  const [arg] = node.arguments;
  return ts.isPropertyAccessExpression(arg) ? arg.name.text === "DEVICE_TOKENS" : ts.isStringLiteralLike(arg) && arg.text === "device_tokens";
}

function enclosingFunction(node) {
  for (let at = node.parent; at; at = at.parent) {
    if ((ts.isMethodDeclaration(at) || ts.isFunctionDeclaration(at)) && at.name) return at;
  }
  return null;
}

function runKind(call, callback) {
  if (!ts.isCallExpression(call) || call.arguments[2] !== callback || !ts.isPropertyAccessExpression(call.expression)) return null;
  const coordinated = call.expression.name.text === "run" && /credentialWrites$/.test(call.expression.expression.getText());
  return coordinated && ts.isStringLiteralLike(call.arguments[1]) ? call.arguments[1].text : null;
}

// The credential kind when `node` runs inside credentialWrites.run(owner, kind, callback).
function coordinatorKind(node) {
  for (let at = node.parent; at; at = at.parent) {
    const kind = (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && at.parent ? runKind(at.parent, at) : null;
    if (kind) return kind;
  }
  return null;
}

function describeWrite(file, call) {
  const fn = enclosingFunction(call);
  return { file, fn: fn ? fn.name.text : null, method: call.expression.name.text, kind: coordinatorKind(call), call };
}

function discoveredWrites() {
  const direct = sourceFiles("src").concat(sourceFiles("scripts")).flatMap(file =>
    nodes(parse(file), node => isMutation(node) && isTokenCollection(node.expression.expression))
      .map(call => describeWrite(file, call)));
  return direct.concat(nodes(parse(TOKEN_READ), isMutation).map(call => describeWrite(TOKEN_READ, call)));
}

const key = write => `${write.file} ${write.fn} ${write.method} ${write.kind}`;
const callsTo = (rel, name) => nodes(parse(rel), node => ts.isCallExpression(node) && callName(node) === name);

// Field names an update can set: literal keys plus `<object>.<field> =` assignments
// in the same function (the heartbeat spreads such an object into its $set).
function writtenFields(write) {
  const fields = new Set();
  for (const node of nodes(write.call.arguments[1], n => ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n))) {
    const name = node.name.getText().replace(/^["']|["']$/g, "");
    if (!name.startsWith("$")) fields.add(name);
  }
  const assigned = nodes(enclosingFunction(write.call), n => ts.isBinaryExpression(n)
    && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left));
  for (const node of assigned) fields.add(node.left.name.text);
  return [...fields].sort();
}

const upserts = write => nodes(write.call, n => ts.isPropertyAssignment(n) && n.name.getText() === "upsert"
  && n.initializer.kind === ts.SyntaxKind.TrueKeyword).length;

describe("device-credential writer inventory (ADR 0072)", () => {
  test("every file naming the device-token collection is classified", () => {
    const referencing = sourceFiles("src").concat(sourceFiles("scripts"))
      .filter(file => nodes(parse(file), namesCollection).length > 0).sort();
    expect(referencing).toEqual(Object.keys(REFERENCES).sort());
  });

  test("writers and hand-offs match the actor table exactly", () => {
    expect(discoveredWrites().map(key).sort()).toEqual(WRITERS.map(key).sort());
    const handoffs = sourceFiles("src").concat(sourceFiles("scripts")).flatMap(file =>
      nodes(parse(file), node => ts.isCallExpression(node) && !isMutation(node) && node.arguments.some(isTokenCollection))
        .map(call => `${file} ${callName(call)}`));
    expect(handoffs.sort()).toEqual(HANDOFFS);
  });

  test("issuance reaches its insert only inside the coordinated issue callback", () => {
    const issues = callsTo(PAIRINGS, "#insertIssuedToken");
    expect(issues).toHaveLength(1);
    expect(issues.map(coordinatorKind)).toEqual(["issue"]);
  });

  test("metadata writers cannot write a field device authentication reads", () => {
    const metadata = discoveredWrites().filter(write => WRITERS.some(row => key(row) === key(write) && !row.authority));
    expect(metadata).toHaveLength(4);
    for (const write of metadata) {
      const fields = writtenFields(write);
      expect(fields.filter(field => !METADATA_FIELDS.has(field))).toEqual([]);
      expect(fields.filter(field => AUTH_FIELDS.includes(field))).toEqual([]);
      expect(upserts(write)).toBe(0);
    }
  });

  test("account erasure is the only bulk device-token delete and runs coordinated", () => {
    const gdpr = parse(GDPR);
    const scoped = nodes(gdpr, n => ts.isVariableDeclaration(n) && n.name.getText() === "USER_SCOPED_COLLECTIONS");
    expect(scoped).toHaveLength(1);
    expect(nodes(scoped[0].initializer, n => ts.isStringLiteralLike(n) && n.text === "deviceTokens")).toHaveLength(2);
    const loops = nodes(gdpr, n => ts.isForOfStatement(n) && n.expression.getText() === "USER_SCOPED_COLLECTIONS"
      && nodes(n.statement, isMutation).length > 0);
    expect(loops.map(loop => enclosingFunction(loop).name.text)).toEqual(["_deleteAll"]);
    const erasures = sourceFiles("src").flatMap(file => callsTo(file, "_deleteAll"));
    expect(erasures.map(call => coordinatorKind(call) || uncoordinatedBranch(call))).toEqual(["erase", "no coordinator"]);
    // The coordinator is absent only when the context has no device-token collection.
    expect(gdpr.text).toContain("db.deviceTokens ? deviceCredentialWritesFor(db, opts.logger) : null");
  });

  test("snapshot restore never writes device tokens", () => {
    const restorable = nodes(parse(BACKUPS), n => ts.isVariableDeclaration(n) && n.name.getText() === "RESTORABLE");
    expect(restorable).toHaveLength(1);
    expect(restorable[0].initializer.getText()).toMatch(/\.filter\(\s*\(\[\s*key\s*\]\)\s*=>\s*!\[\s*"deviceTokens",/);
  });
});

function uncoordinatedBranch(call) {
  const branch = call.parent;
  const guarded = ts.isConditionalExpression(branch) && branch.whenFalse === call
    && branch.condition.getText() === "this.credentialWrites";
  return guarded ? "no coordinator" : "unguarded";
}
