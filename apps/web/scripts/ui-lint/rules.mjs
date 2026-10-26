import { createHash } from "node:crypto";
import ts from "typescript";

// Only these visualization surfaces may define literal chart/stream colors.
// This exception applies to hex colors, never to dialog or focus rules.
export const HEX_ALLOWLIST = {
  prefixes: ["components/overlay/", "components/analyzer/charts/"],
  files: [
    "components/cards/RadarChart.tsx",
    "components/analyzer/mmr/MmrBucketChart.tsx",
    "components/analyzer/StrategyTendencyChart.tsx",
    "components/analyzer/explorer/ExplorerCharts.tsx",
    "components/instant/report/OfflineMacroChart.tsx",
  ],
};

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const pathName = (path) => path.replaceAll("\\", "/");
const isLiteral = (node) => ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node);
const isText = (node) => isLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
const propertyName = (node) => ts.isIdentifier(node) || isLiteral(node) ? node.text : null;
const isScope = (node) => ts.isSourceFile(node) || ts.isFunctionLike(node) || ts.isBlock(node) || ts.isCatchClause(node)
  || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isCaseBlock(node);

function normalize(node, source) {
  const printed = printer.printNode(ts.EmitHint.Unspecified, node, source);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, printed);
  const tokens = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    // The decoded literal value makes single/double quotes equivalent, while
    // preserving meaningful text and avoiding source line-number exemptions.
    const value = kind === ts.SyntaxKind.StringLiteral ? JSON.stringify(scanner.getTokenValue()) : scanner.getTokenText();
    tokens.push(`${kind}:${value}`);
  }
  return { signature: createHash("sha256").update(tokens.join("\0")).digest("hex"), example: printed.replace(/\s+/g, " ").slice(0, 180) };
}

function declaredBindings(source) {
  const scopes = new Map();
  function scopeOf(node, functionOnly = false) {
    for (let at = node; at; at = at.parent) {
      if (functionOnly ? ts.isFunctionLike(at) || ts.isSourceFile(at) : isScope(at)) return at;
    }
    return source;
  }
  function bind(scope, name, initializer) {
    if (!name) return;
    if (ts.isIdentifier(name)) {
      if (!scopes.has(scope)) scopes.set(scope, new Map());
      scopes.get(scope).set(name.text, initializer);
    } else if (ts.isBindingPattern(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element)) bind(scope, element.name);
    }
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      const lexical = Boolean(node.parent.flags & ts.NodeFlags.BlockScoped);
      bind(scopeOf(node.parent, !lexical), node.name, node.initializer);
    } else if (ts.isParameter(node)) bind(scopeOf(node.parent), node.name);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) bind(scopeOf(node.parent), node.name);
    else if (ts.isFunctionExpression(node) && node.name) bind(node, node.name);
    else if (ts.isImportClause(node) && node.name) bind(source, node.name);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) bind(source, node.name);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return {
    isShadowed(node, name) {
      for (let at = node; at; at = at.parent) if (scopes.get(at)?.has(name)) return true;
      return false;
    },
    initializer(node, name) {
      for (let at = node; at; at = at.parent) {
        if (scopes.get(at)?.has(name)) return scopes.get(at).get(name);
      }
      return undefined;
    },
  };
}

function stringValues(node, bindings, seen = new Set()) {
  if (!node || seen.has(node)) return [];
  seen.add(node);
  if (isText(node)) return [node.text];
  if (ts.isIdentifier(node)) return stringValues(bindings.initializer(node, node.text), bindings, seen);
  const result = [];
  ts.forEachChild(node, (child) => { result.push(...stringValues(child, bindings, seen)); });
  return result;
}

function classViolations(text) {
  const result = [];
  if (/(?:^|\s)(?:[^\s]+:)*outline-none(?:\s|$)/.test(text)
    && !/(?:^|\s)(?:[^\s]+:)*ring(?:-[01248])?(?:\s|$)/.test(text)) result.push("focus-without-ring");
  const small = /(?:^|\s)(?:[^\s]+:)*text-\[(?:length:)?(\d*\.?\d+)(px|rem)\](?=\s|$)/g;
  for (const match of text.matchAll(small)) {
    if (Number(match[1]) * (match[2] === "rem" ? 16 : 1) < 12) result.push("small-arbitrary-text");
  }
  return result;
}

function hexColors(node, source) {
  // Fragment IDs and SVG url(#filter) references are not color literals.
  let context = node.parent;
  while (context && (ts.isJsxExpression(context) || ts.isTemplateExpression(context)
    || ts.isTemplateSpan(context) || ts.isParenthesizedExpression(context))) context = context.parent;
  const name = ts.isJsxAttribute(context) ? context.name.getText(source)
    : ts.isPropertyAssignment(context) || ts.isVariableDeclaration(context) ? propertyName(context.name) : null;
  if (name && /^(?:href|id|htmlFor|src|srcSet|action|formAction|xlinkHref|url|uri|hash|anchor|aria-(?:controls|describedby|labelledby|owns))$/i.test(name)) return [];
  if (/^(?:https?:|\/|\.\/|\.\.\/)/i.test(node.text.trim())) return [];
  return [...node.text.matchAll(/#[\da-fA-F]{8}\b|#[\da-fA-F]{6}\b|#[\da-fA-F]{4}\b|#[\da-fA-F]{3}\b/g)]
    .filter((match) => !/url\(\s*['"]?$/i.test(node.text.slice(0, match.index))
      && !/^\s*(?:\{|:|\.)/.test(node.text.slice(match.index + match[0].length)));
}

export function analyzeSource(file, text) {
  file = pathName(file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bindings = declaredBindings(source);
  const { isShadowed } = bindings;
  const insideUi = file.startsWith("components/ui/");
  const hexAllowed = HEX_ALLOWLIST.prefixes.some((prefix) => file.startsWith(prefix)) || HEX_ALLOWLIST.files.includes(file);
  const found = [];
  function report(rule, node) {
    const normalized = normalize(node, source);
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ file, rule, ...normalized, line: position.line + 1, column: position.character + 1 });
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && ["confirm", "prompt"].includes(node.expression.text) && !isShadowed(node, node.expression.text)) report("native-confirm-prompt", node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = node.expression;
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression && propertyName(node.argumentExpression);
      if (ts.isIdentifier(base) && ["window", "globalThis", "self"].includes(base.text)
        && ["confirm", "prompt"].includes(name) && !isShadowed(node, base.text)) {
        report("native-confirm-prompt", ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : node);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
      && node.initializer && ts.isIdentifier(node.initializer)
      && ["window", "globalThis", "self"].includes(node.initializer.text) && !isShadowed(node, node.initializer.text)) {
      for (const element of node.name.elements) {
        if (["confirm", "prompt"].includes(propertyName(element.propertyName || element.name))) report("native-confirm-prompt", node);
      }
    }
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "role" && !insideUi) {
      const value = stringValues(node.initializer, bindings);
      if (value.includes("dialog") || value.includes("alertdialog")) report("dialog-outside-ui", node.parent.parent);
    }
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "role" && !insideUi
      && stringValues(node.initializer, bindings).some((value) => value === "dialog" || value === "alertdialog")) report("dialog-outside-ui", node.parent);
    if (isText(node)) {
      for (const rule of classViolations(node.text)) report(rule, node);
      if (!hexAllowed) {
        for (const _match of hexColors(node, source)) report("hex-outside-visualization", node);
      }
    }
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && !insideUi && ["a", "Link"].includes(node.tagName.getText(source))) {
      const attribute = node.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === "className");
      const classes = attribute && stringValues(attribute.initializer, bindings).join(" ");
      if (classes && /(?:^|\s)hard-press(?:\s|$)/.test(classes) && /(?:^|\s)rounded-full(?:\s|$)/.test(classes)) report("handrolled-link-button", node);
      if (classes && (file.startsWith("app/") || file.startsWith("components/landing/"))
        && /(?:^|\s)rounded-(?:md|lg)(?:\s|$)/.test(classes) && /(?:^|\s)bg-accent(?:\s|$)/.test(classes)) report("handrolled-accent-link", node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

export function aggregateViolations(violations) {
  const entries = new Map();
  for (const { file, rule, signature, example } of violations) {
    const key = `${file}\0${rule}\0${signature}`;
    const entry = entries.get(key);
    if (entry) entry.count += 1;
    else entries.set(key, { file, rule, signature, count: 1, example });
  }
  return [...entries.values()].sort((a, b) => {
    const left = `${a.file}\0${a.rule}\0${a.signature}`;
    const right = `${b.file}\0${b.rule}\0${b.signature}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function validateBaseline(entries) {
  const known = new Set(["native-confirm-prompt", "dialog-outside-ui", "focus-without-ring", "small-arbitrary-text",
    "hex-outside-visualization", "handrolled-link-button", "handrolled-accent-link"]);
  const seen = new Set();
  if (!Array.isArray(entries)) throw new Error("ui-lint: baseline entries must be an array");
  for (const entry of entries) {
    if (!entry || typeof entry.file !== "string" || !/^(app|components|lib)\//.test(entry.file)
      || entry.file.includes("\\") || entry.file.split("/").some((part) => part === ".." || part === ".")
      || !known.has(entry.rule) || !/^[a-f0-9]{64}$/.test(entry.signature)
      || !Number.isSafeInteger(entry.count) || entry.count < 1 || typeof entry.example !== "string") {
      throw new Error("ui-lint: malformed baseline entry");
    }
    const key = `${entry.file}\0${entry.rule}\0${entry.signature}`;
    if (seen.has(key)) throw new Error("ui-lint: duplicate baseline signature");
    seen.add(key);
  }
}

export function compareBaseline(current, baseline) {
  const key = (entry) => `${entry.file}\0${entry.rule}\0${entry.signature}`;
  const old = new Map(baseline.map((entry) => [key(entry), entry]));
  const next = new Map(current.map((entry) => [key(entry), entry]));
  return {
    added: current.filter((entry) => entry.count > (old.get(key(entry))?.count || 0)),
    stale: baseline.filter((entry) => entry.count > (next.get(key(entry))?.count || 0)),
  };
}
