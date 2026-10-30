// @ts-nocheck
"use strict";

// Fail-closed lexical inventory of device-credential writes for ADR 0072
// (docs/adr/0072-serving-cohort-coherence.md). Review keeps these lists and the
// ADR's actor table in step; this test does not read the ADR. It fails when:
// - a file names the collection, or an exported list that names it, unclassified;
// - an expression resolving to the collection (property, element access,
//   `collection(...)`, a local alias or a destructured binding) is used other than
//   as a read receiver, a listed writer receiver, a listed hand-off or the context
//   definition, or a read could write ($out/$merge, a TTL index);
// - a write in a classified file has a receiver that is neither resolved nor one
//   of the listed loops and parameters;
// - an authority write is not awaited inside the coordinator for the same owner;
// - a metadata writer sets anything but metadata fields through a literal
//   document, or may upsert.
// Named limitations (ADR 0072): lexical evidence only, not a runtime, failover,
// clock or separate-process proof. It cannot see manual edits, raw restores, code
// outside apps/api, iteration over the whole COLLECTIONS or schema registry, or a
// collection reached through a parameter of a function in an unclassified file.

const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const { USER_SCOPED_COLLECTIONS, PURGE_ONLY_COLLECTIONS } = require("../src/services/gdpr");
const { RESTORABLE } = require("../src/services/userBackups");
const { TOKEN_COLLECTIONS } = require("../src/services/gdprOwnedData");

const API = path.join(__dirname, "..");
const PAIRINGS = "src/services/devicePairings.js";
const TOKEN_READ = "src/services/deviceAuthTokenRead.js";
const GDPR = "src/services/gdpr.js";
const BACKUPS = "src/services/userBackups.js";
const CONNECT = "src/db/connect.js";
const WRITE_METHODS = new Set(["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne",
  "deleteMany", "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete", "bulkWrite", "drop", "rename",
  "initializeOrderedBulkOp", "initializeUnorderedBulkOp", "mapReduce", "dropIndex", "dropIndexes"]);
const READ_METHODS = new Set(["find", "findOne", "countDocuments", "estimatedDocumentCount", "distinct",
  "aggregate", "createIndex", "createIndexes", "listIndexes", "indexes", "indexExists", "indexInformation"]);
const DB_LEVEL = new Set(["dropCollection", "renameCollection", "command", "runCommand", "dropDatabase", "bulkWrite"]);
const AUTHORITY_FIELDS = new Set(["tokenHash", "revokedAt", "userId", "_id"]);
const METADATA_FIELDS = new Set(["lastSeenAt", "label", "connectedEventRecordedAt",
  "agentVersion", "agentOs", "agentOsRelease", "hostname"]);
const REGISTRIES = new Set(["COLLECTIONS", "REGISTRY"]);
// Exported lists that name the collection; reaching one counts as naming it.
const LISTS = ["DASHBOARD_COLLECTIONS", "GDPR_CLASSIFICATION", "RESTORABLE", "USER_SCOPED_COLLECTIONS"];
const REFERENCES = {
  "scripts/relink-clerk-user.js": "read",
  "src/config/constants.js": "definition",
  [CONNECT]: "definition",
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
// ADR 0072 actor table, direct writes. Erase is the gdpr loop; touch is a hand-off.
const WRITERS = [
  { fn: "#insertIssuedToken", method: "insertOne", kind: null },
  { fn: "revoke", method: "updateOne", kind: "revoke-hash" },
  { fn: "revokeById", method: "updateOne", kind: "revoke-id" },
  { fn: "setLabel", method: "updateOne", kind: null },
  { fn: "recordHeartbeat", method: "findOneAndUpdate", kind: null },
  { fn: "recordHeartbeat", method: "updateOne", kind: null },
];
const HANDOFFS = [`${PAIRINGS} handoff:readDeviceAuthSnapshot`, `${PAIRINGS} handoff:readDeviceTokenCore`];
// Writes in classified files whose receiver comes from a loop or a parameter.
const DYNAMIC = [
  `${BACKUPS} restore deleteMany loop:RESTORABLE`,
  `${BACKUPS} restore insertMany loop:RESTORABLE`,
  `${BACKUPS} restore insertMany loop:RESTORABLE`,
  `${BACKUPS} restoreUserSettings updateOne param:users`,
  `${BACKUPS} restoreUserSettings updateOne param:users`,
  `${GDPR} _deleteAll deleteMany loop:PURGE_ONLY_COLLECTIONS`,
  `${GDPR} _deleteAll deleteMany loop:PURGE_ONLY_COLLECTIONS`,
  `${GDPR} _deleteAll deleteMany loop:USER_SCOPED_COLLECTIONS`,
  `${GDPR} _deleteAll deleteMany loop:USER_SCOPED_COLLECTIONS`,
  `${TOKEN_READ} readDeviceTokenCore updateOne param:collection`,
];
const FIELDS_FROM_UPDATE = "Object.fromEntries(Object.entries(update).map(([key, value]) => [key, { $literal: value }]))";

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
const allFiles = () => sourceFiles("src").concat(sourceFiles("scripts"));

function nodes(root, keep) {
  const found = [];
  const visit = node => { if (keep(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return found;
}

const strip = node => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
  return node;
};
const outer = node => {
  let at = node.parent;
  while (at && (ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at))) at = at.parent;
  return at;
};
const contains = (outerNode, inner) => inner.pos >= outerNode.pos && inner.end <= outerNode.end;
const isTokenString = text => text === "deviceTokens" || text === "device_tokens" || /\.device_tokens$/.test(text);
const directName = node => (ts.isIdentifier(node) && (node.text === "deviceTokens" || node.text === "DEVICE_TOKENS"))
  || (ts.isStringLiteralLike(node) && isTokenString(node.text));
const namesCollection = node => directName(node) || (ts.isIdentifier(node) && LISTS.includes(node.text));
const calleeName = call => {
  const callee = strip(call.expression);
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText();
};

function tokenLiteral(node) {
  node = strip(node);
  return !!node && ((ts.isPropertyAccessExpression(node) && node.name.text === "DEVICE_TOKENS")
    || (ts.isStringLiteralLike(node) && isTokenString(node.text)));
}

// An expression that evaluates to the device-token collection itself.
function isTokenHandle(node) {
  node = strip(node);
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "deviceTokens";
  if (ts.isElementAccessExpression(node)) return tokenLiteral(node.argumentExpression);
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  return node.expression.name.text === "collection" && node.arguments.length > 0 && tokenLiteral(node.arguments[0]);
}

function declarationsIn(scope, id) {
  const found = [];
  const visit = node => {
    if (node !== scope && ts.isFunctionLike(node) && !contains(node, id)) return;
    const named = ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node);
    if (named && ts.isIdentifier(node.name) && node.name.text === id.text && node.name !== id) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

function declarationOf(id) {
  for (let scope = id.parent; scope; scope = scope.parent) {
    const found = declarationsIn(scope, id);
    if (found.length) return found[found.length - 1];
  }
  return null;
}

function bindingKind(element) {
  const key = element.propertyName || element.name;
  if (!ts.isObjectBindingPattern(element.parent) || !(ts.isIdentifier(key) || ts.isStringLiteralLike(key))) {
    return `binding:${element.name.getText()}`;
  }
  return isTokenString(key.text) ? "token" : "other";
}

function keySource(key) {
  key = strip(key);
  const declaration = ts.isIdentifier(key) ? declarationOf(key) : null;
  for (let at = declaration; at; at = at.parent) {
    if (ts.isForOfStatement(at) && contains(at.initializer, declaration)) return `loop:${at.expression.getText()}`;
  }
  return `dynamic:${key.getText()}`;
}

function identifierKind(id, depth) {
  const declaration = declarationOf(id);
  if (!declaration) return `free:${id.text}`;
  if (ts.isParameter(declaration)) return `param:${id.text}`;
  if (ts.isBindingElement(declaration)) return bindingKind(declaration);
  return declaration.initializer ? receiverKind(declaration.initializer, depth + 1) : `unset:${id.text}`;
}

const elementKind = node => (ts.isStringLiteralLike(strip(node.argumentExpression)) ? "other" : keySource(node.argumentExpression));
function collectionCallKind(node) {
  const name = strip(node.arguments[0]);
  return name && (ts.isStringLiteralLike(name) || ts.isPropertyAccessExpression(name)) ? "other" : "dynamic:collection";
}

// "token", "other", or a label for a receiver the source does not resolve statically.
function receiverKind(node, depth = 0) {
  node = strip(node);
  if (isTokenHandle(node)) return "token";
  if (ts.isPropertyAccessExpression(node)) return "other";
  if (ts.isElementAccessExpression(node)) return elementKind(node);
  if (ts.isCallExpression(node) && calleeName(node) === "collection") return collectionCallKind(node);
  if (ts.isIdentifier(node) && depth < 4) return identifierKind(node, depth);
  return `unresolved:${node.getText()}`;
}

function functionName(node) {
  for (let at = node.parent; at; at = at.parent) {
    if ((ts.isMethodDeclaration(at) || ts.isFunctionDeclaration(at)) && at.name) return at.name.text;
  }
  return null;
}

function isReference(node) {
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node) return false;
  const declares = ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent);
  return !(declares && parent.name === node) && !(ts.isBindingElement(parent) && parent.propertyName === node);
}

function aliasNames(sf) {
  const names = new Set();
  for (const declaration of nodes(sf, n => ts.isVariableDeclaration(n) || ts.isBindingElement(n))) {
    if (!ts.isIdentifier(declaration.name)) continue;
    const kind = ts.isBindingElement(declaration) ? bindingKind(declaration)
      : declaration.initializer ? receiverKind(declaration.initializer) : "unset";
    if (kind === "token") names.add(declaration.name.text);
  }
  return names;
}

const isTest = (parent, at) => (ts.isConditionalExpression(parent) && parent.condition === at)
  || (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken)
  || (ts.isIfStatement(parent) && parent.expression === at)
  || (ts.isBinaryExpression(parent) && parent.left === at && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken);

function memberUse(access) {
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.expression !== access) return { use: `escape:member:${access.name.text}` };
  return { use: `${READ_METHODS.has(access.name.text) ? "read" : "write"}:${access.name.text}`, call };
}

function valueUse(parent, at) {
  const passed = (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && (parent.arguments || []).includes(at);
  if (passed) return `handoff:${calleeName(parent)}`;
  if (ts.isPropertyAssignment(parent) && parent.initializer === at) return `definition:${parent.name.getText()}`;
  return isTest(parent, at) ? "test" : `escape:${ts.SyntaxKind[parent.kind]}`;
}

function useOf(node) {
  let at = node;
  while (ts.isParenthesizedExpression(at.parent) || ts.isNonNullExpression(at.parent)) at = at.parent;
  const parent = at.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === at) return memberUse(parent);
  if (ts.isVariableDeclaration(parent) && parent.initializer === at) return { use: "alias" };
  return { use: valueUse(parent, at) };
}

// Every place a file uses the collection itself, directly or through a local alias.
function tokenUses(file) {
  const sf = parse(file), aliases = aliasNames(sf);
  const handles = nodes(sf, n => !ts.isParenthesizedExpression(n) && !ts.isNonNullExpression(n) && isTokenHandle(n));
  const references = nodes(sf, n => ts.isIdentifier(n) && aliases.has(n.text) && isReference(n)
    && identifierKind(n, 0) === "token");
  return handles.concat(references).map(node => ({ file, node, fn: functionName(node), ...useOf(node) }));
}

const isWriteCall = node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(strip(node.expression))
  && WRITE_METHODS.has(strip(node.expression).name.text);
const isRunCallee = callee => ts.isPropertyAccessExpression(callee) && callee.name.text === "run"
  && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "credentialWrites";

// The credentialWrites.run(owner, kind, callback) call whose callback holds `node`.
function runCallOf(node) {
  for (let at = node.parent; at; at = at.parent) {
    const call = at.parent;
    const callback = ts.isArrowFunction(at) || ts.isFunctionExpression(at);
    if (callback && call && ts.isCallExpression(call) && call.arguments[2] === at && isRunCallee(call.expression)) return call;
  }
  return null;
}
const runKindOf = run => (run && ts.isStringLiteralLike(run.arguments[1]) ? run.arguments[1].text : null);

// True when the promise of `call` is awaited, returned or an arrow's result up to `stop`.
function settled(call, stop) {
  let node = call;
  for (let depth = 0; depth < 5; depth += 1) {
    const parent = outer(node);
    if (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent)) return true;
    if (ts.isConditionalExpression(parent) && parent.condition !== node) { node = parent; continue; }
    if (!ts.isArrowFunction(parent) || strip(parent.body) !== node) return false;
    if (parent === stop) return true;
    if (!ts.isCallExpression(parent.parent)) return false;
    node = parent.parent;
  }
  return false;
}

function ownerOf(write) {
  const [owner] = nodes(write.arguments[0], n => (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n))
    && n.name.getText() === "userId");
  if (!owner) return null;
  return ts.isShorthandPropertyAssignment(owner) ? "userId" : owner.initializer.getText();
}

const callsTo = (rel, name) => nodes(parse(rel), node => ts.isCallExpression(node) && calleeName(node) === name);
const directWrites = fn => tokenUses(PAIRINGS).filter(use => use.fn === fn && use.use.startsWith("write:")).map(use => use.call);
const loopWrites = list => nodes(parse(GDPR), isWriteCall)
  .filter(call => receiverKind(strip(call.expression).expression) === `loop:${list}`);

function fallbackBranch(call) {
  const branch = outer(call), condition = branch && strip(branch.condition);
  const guarded = ts.isConditionalExpression(branch) && branch.whenFalse === call && ts.isPropertyAccessExpression(condition)
    && condition.name.text === "credentialWrites" && condition.expression.kind === ts.SyntaxKind.ThisKeyword;
  return guarded ? "no coordinator" : "unguarded";
}

function exportedLists() {
  return Object.keys(REFERENCES).flatMap(file => {
    const sf = parse(file);
    const exported = new Set(nodes(sf, n => ts.isBinaryExpression(n) && n.left.getText() === "module.exports"
      && ts.isObjectLiteralExpression(n.right)).flatMap(n => n.right.properties.map(p => (p.name ? p.name.getText() : ""))));
    return sf.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations)
      .filter(d => ts.isIdentifier(d.name) && d.initializer && exported.has(d.name.text) && nodes(d.initializer, directName).length)
      .map(d => d.name.text);
  }).filter(name => !REGISTRIES.has(name)).sort();
}

const propertyNamed = (root, names) => nodes(root, n => ts.isPropertyAssignment(n) && names.includes(n.name.text));
function readCanWrite(use) {
  if (use.use === "read:aggregate") {
    const pipeline = strip(use.call.arguments[0]);
    return !pipeline || !ts.isArrayLiteralExpression(pipeline) || propertyNamed(pipeline, ["$out", "$merge"]).length > 0;
  }
  if (use.use === "read:createIndex" || use.use === "read:createIndexes") {
    return use.call.arguments.some(arg => !ts.isObjectLiteralExpression(strip(arg)) && !ts.isArrayLiteralExpression(strip(arg)))
      || propertyNamed(use.call, ["expireAfterSeconds"]).length > 0;
  }
  return false;
}

// The `$set` objects of an update document or pipeline; null for any other shape.
function setStages(update) {
  update = strip(update);
  const stages = update && ts.isArrayLiteralExpression(update) ? update.elements : [update];
  const sets = stages.map(stage => {
    stage = strip(stage);
    if (!stage || !ts.isObjectLiteralExpression(stage) || stage.properties.length !== 1) return null;
    const [only] = stage.properties;
    const set = ts.isPropertyAssignment(only) && only.name.text === "$set" ? strip(only.initializer) : null;
    return set && ts.isObjectLiteralExpression(set) ? set : null;
  });
  return sets.includes(null) ? null : sets;
}

const isAssignedProperty = access => ts.isPropertyAccessExpression(access) && ts.isBinaryExpression(access.parent)
  && access.parent.left === access && access.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
function startsEmpty(fn) {
  const [declaration] = nodes(fn, n => ts.isVariableDeclaration(n) && n.name.getText() === "update");
  return !!declaration && ts.isObjectLiteralExpression(declaration.initializer) && !declaration.initializer.properties.length;
}

// Field names the heartbeat assigns to its `update` object, or markers for any other use of it.
function updateAssignments(fn) {
  const fields = [];
  let reads = 0;
  for (const ref of nodes(fn, n => ts.isIdentifier(n) && n.text === "update" && isReference(n))) {
    if (isAssignedProperty(ref.parent)) fields.push(ref.parent.name.text);
    else if (ts.isCallExpression(ref.parent) && ref.parent.expression.getText() === "Object.entries") reads += 1;
    else fields.push("<update-escape>");
  }
  return reads === 1 && startsEmpty(fn) ? fields : fields.concat("<update-shape>");
}

function setFields(set, fn) {
  return set.properties.flatMap(member => {
    if (ts.isSpreadAssignment(member)) {
      const declaration = ts.isIdentifier(member.expression) ? declarationOf(member.expression) : null;
      const pinned = declaration && declaration.initializer && declaration.initializer.getText() === FIELDS_FROM_UPDATE;
      return pinned ? updateAssignments(fn) : ["<spread>"];
    }
    const plain = (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member))
      && (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name));
    return [plain ? member.name.text : "<computed>"];
  });
}

function mayUpsert(write) {
  const options = strip(write.arguments[2]);
  if (!options) return false;
  if (!ts.isObjectLiteralExpression(options)) return true;
  return options.properties.some(p => !ts.isPropertyAssignment(p)
    || (p.name.text === "upsert" && p.initializer.kind !== ts.SyntaxKind.FalseKeyword));
}

test("ADR 0072: every file naming the collection, or a list that names it, is classified", () => {
  expect(exportedLists()).toEqual(LISTS);
  const referencing = allFiles().filter(file => nodes(parse(file), namesCollection).length > 0).sort();
  expect(referencing).toEqual(Object.keys(REFERENCES).sort());
});

test("ADR 0072: the collection is used only by reads, listed writers, listed hand-offs and the context", () => {
  const uses = allFiles().flatMap(tokenUses);
  expect(uses.filter(use => use.use.startsWith("escape:")).map(use => `${use.file} ${use.fn} ${use.use}`)).toEqual([]);
  const writes = uses.filter(use => use.use.startsWith("write:"))
    .map(use => `${use.file} ${use.fn} ${use.call.expression.name.text} ${runKindOf(runCallOf(use.call))}`);
  expect(writes.sort()).toEqual(WRITERS.map(w => `${PAIRINGS} ${w.fn} ${w.method} ${w.kind}`).sort());
  expect(uses.filter(use => use.use.startsWith("handoff:")).map(use => `${use.file} ${use.use}`).sort()).toEqual(HANDOFFS);
  expect(uses.filter(use => use.use.startsWith("definition:")).map(use => `${use.file} ${use.use}`))
    .toEqual([`${CONNECT} definition:deviceTokens`]);
});

test("ADR 0072: no read, pipeline stage or database-level call can write the collection", () => {
  const uses = allFiles().flatMap(tokenUses);
  expect(uses.filter(readCanWrite).map(use => `${use.file} ${use.fn} ${use.use}`)).toEqual([]);
  const outputs = allFiles().flatMap(file => propertyNamed(parse(file), ["$out", "$merge"])
    .filter(p => nodes(p.initializer, directName).length).map(() => file));
  expect(outputs).toEqual([]);
  const dbLevel = allFiles().flatMap(file => nodes(parse(file), n => ts.isCallExpression(n) && DB_LEVEL.has(calleeName(n))
    && n.arguments.some(arg => nodes(arg, directName).length)).map(() => file));
  expect(dbLevel).toEqual([]);
});

test("ADR 0072: every unresolved write in a classified file comes from a listed loop or parameter", () => {
  const dynamic = Object.keys(REFERENCES).concat(TOKEN_READ).flatMap(file => nodes(parse(file), isWriteCall)
    .map(call => ({ file, call, kind: receiverKind(strip(call.expression).expression) }))
    .filter(write => write.kind !== "token" && write.kind !== "other")
    .map(write => `${write.file} ${functionName(write.call)} ${strip(write.call.expression).name.text} ${write.kind}`));
  expect(dynamic.sort()).toEqual([...DYNAMIC].sort());
  // Of the lists those loops and helpers iterate, only the erase list holds the collection.
  expect(USER_SCOPED_COLLECTIONS.filter(([key]) => isTokenString(key))).toEqual([["deviceTokens", "deviceTokens"]]);
  for (const list of [PURGE_ONLY_COLLECTIONS, RESTORABLE, TOKEN_COLLECTIONS]) {
    expect(list.flat().filter(value => typeof value === "string" && isTokenString(value))).toEqual([]);
  }
});

test("ADR 0072: revocation and issuance are awaited inside the coordinator for the same owner", () => {
  for (const [fn, kind] of [["revoke", "revoke-hash"], ["revokeById", "revoke-id"]]) {
    const [write] = directWrites(fn), run = runCallOf(write);
    expect([runKindOf(run), settled(write, run.arguments[2]), ownerOf(write)]).toEqual([kind, true, run.arguments[0].getText()]);
  }
  const [insert] = directWrites("#insertIssuedToken");
  const issues = callsTo(PAIRINGS, "#insertIssuedToken");
  expect(issues.map(call => runKindOf(runCallOf(call)))).toEqual(["issue"]);
  const run = runCallOf(issues[0]);
  expect([settled(insert, null), settled(issues[0], run.arguments[2]), ownerOf(insert)])
    .toEqual([true, true, run.arguments[0].getText()]);
});

test("ADR 0072: account erasure reaches the collection only through the coordinator", () => {
  const erasures = loopWrites("USER_SCOPED_COLLECTIONS");
  expect(erasures.map(write => [functionName(write), settled(write, null), ownerOf(write)]))
    .toEqual([["_deleteAll", true, "userId"], ["_deleteAll", true, "userId"]]);
  const callers = allFiles().flatMap(file => callsTo(file, "_deleteAll"));
  expect(callers.map(call => runKindOf(runCallOf(call)) || fallbackBranch(call))).toEqual(["erase", "no coordinator"]);
  expect(settled(callers[0], runCallOf(callers[0]).arguments[2])).toBe(true);
  // The coordinator is missing only when the context has no device-token collection.
  const assignments = nodes(parse(GDPR), n => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && n.left.getText() === "this.credentialWrites");
  expect(assignments).toHaveLength(1);
  const [guard] = nodes(assignments[0].right, ts.isConditionalExpression);
  expect([isTokenHandle(guard.condition), calleeName(strip(guard.whenTrue))]).toEqual([true, "deviceCredentialWritesFor"]);
});

test("ADR 0072: metadata writers set only metadata fields through literal documents and never upsert", () => {
  const writes = [...directWrites("setLabel"), ...directWrites("recordHeartbeat"), ...nodes(parse(TOKEN_READ), isWriteCall)];
  expect(writes).toHaveLength(4);
  for (const write of writes) {
    const fn = ts.findAncestor(write, n => ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n));
    const sets = setStages(write.arguments[1]);
    expect(sets).not.toBeNull();
    const fields = sets.flatMap(set => setFields(set, fn));
    expect(fields.filter(field => !METADATA_FIELDS.has(field) || AUTHORITY_FIELDS.has(field))).toEqual([]);
    expect(mayUpsert(write)).toBe(false);
  }
});
