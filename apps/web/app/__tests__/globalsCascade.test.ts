// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import postcss, { type AtRule, type Node, type Root, type Rule } from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import tailwindConfig from "@/tailwind.config";

/**
 * Cascade guard for app/globals.css.
 *
 * Every unlayered rule in globals.css is emitted AFTER Tailwind's
 * utilities. An element or universal selector with a pseudo-class
 * (`a:hover`, `*:focus-visible`) then has at least the specificity of a
 * utility class and wins on source order, silently overriding utilities
 * on every element it matches: primary CTA labels took the link hover
 * colour, and focused pills lost their `rounded-full`. Such defaults
 * belong in `@layer base`, with the element wrapped in :where().
 */
const GLOBALS_PATH = path.resolve(process.cwd(), "app/globals.css");
const GLOBALS_CSS = readFileSync(GLOBALS_PATH, "utf8");

/** Single-colon pseudo-elements (CSS2 syntax), not pseudo-classes. */
const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);

/** Replaces every `:name( … )` group (balanced parentheses) with `replacement`. */
function replaceFunctionalPseudo(selector: string, name: string, replacement: string): string {
  const opener = `:${name}(`;
  let result = selector;
  for (let start = result.indexOf(opener); start !== -1; start = result.indexOf(opener)) {
    let depth = 0;
    let end = start + opener.length - 1;
    for (; end < result.length; end += 1) {
      if (result[end] === "(") depth += 1;
      else if (result[end] === ")" && --depth === 0) break;
    }
    result = result.slice(0, start) + replacement + result.slice(end + 1);
  }
  return result;
}

/**
 * True when `selector` hooks onto no class, id or attribute (it matches by
 * element type, or universally) yet carries a pseudo-class: the shape whose
 * specificity ties or beats a utility class, so it wins on source order
 * when left unlayered.
 *
 * - `:where()` adds no specificity, so its contents are ignored.
 * - `:not()` counts as a pseudo-class but cannot hook a selector
 *   (`a:not(.btn):hover` still matches every other link), so its contents
 *   are ignored too.
 * - A lone `:root` compound only ever matches <html>, where the design
 *   tokens live, so it is exempt.
 */
function isBareStateSelector(selector: string): boolean {
  const stripped = replaceFunctionalPseudo(
    replaceFunctionalPseudo(selector, "where", ""),
    "not",
    ":not",
  ).trim();
  if (/^:root(?![\w-])[^\s>+~]*$/.test(stripped)) return false;
  if (/[.#[]/.test(stripped)) return false;
  return [...stripped.matchAll(/(?<!:):([a-z-]+)/gi)].some(
    (match) => !LEGACY_PSEUDO_ELEMENTS.has(match[1].toLowerCase()),
  );
}

function ancestorAtRules(node: Rule): string[] {
  const names: string[] = [];
  for (let parent: Node | undefined = node.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule") names.push((parent as AtRule).name.toLowerCase());
  }
  return names;
}

/** `selector` of every unlayered style rule (keyframe steps excluded). */
function unlayeredSelectors(root: Root): string[] {
  const selectors: string[] = [];
  root.walkRules((rule) => {
    const atRules = ancestorAtRules(rule);
    if (atRules.includes("layer") || atRules.some((name) => name.endsWith("keyframes"))) return;
    selectors.push(...rule.selectors);
  });
  return selectors;
}

/** Rules inside `@layer base`, keyed by their selector text. */
function baseLayerRules(root: Root): Map<string, Rule> {
  const rules = new Map<string, Rule>();
  root.walkAtRules("layer", (layer) => {
    if (layer.params.trim() !== "base") return;
    layer.walkRules((rule) => {
      rules.set(rule.selector, rule);
    });
  });
  return rules;
}

function declarations(rule: Rule | undefined): Record<string, string> {
  const props: Record<string, string> = {};
  rule?.walkDecls((decl) => {
    props[decl.prop] = decl.value;
  });
  return props;
}

describe("isBareStateSelector", () => {
  it.each([
    "a:hover",
    "*:focus-visible",
    ":focus-visible",
    "button:hover:not(:disabled)",
    "nav > a:focus",
    "a:not(.btn):hover",
    ":where(a):hover",
    "li:first-child",
  ])("flags %s", (selector) => {
    expect(isBareStateSelector(selector)).toBe(true);
  });

  it.each([
    "a",
    "html",
    "h1",
    "*",
    "*::before",
    "body::before",
    "::selection",
    ":root",
    ':root[data-theme="dark"]',
    ":root:not([data-theme])",
    ".cl-formButtonPrimary:hover",
    ".drop-initial::first-letter",
    ".hard-press:active",
    '.replay-scope input[type="range"].replay-range:focus-visible',
    "a:before",
  ])("allows %s", (selector) => {
    expect(isBareStateSelector(selector)).toBe(false);
  });
});

describe("app/globals.css cascade", () => {
  const root = postcss.parse(GLOBALS_CSS, { from: GLOBALS_PATH });

  it("has no unlayered element or universal rule with a pseudo-class", () => {
    const offenders = unlayeredSelectors(root).filter(isBareStateSelector);
    expect(
      offenders,
      "Move these into `@layer base` and wrap the element in :where() so utilities can override them",
    ).toEqual([]);
  });

  it("keeps the link colour and its hover in the base layer", () => {
    const base = baseLayerRules(root);
    expect(declarations(base.get("a"))).toEqual({ color: "rgb(var(--accent))" });
    expect(declarations(base.get(":where(a):hover"))).toEqual({ color: "rgb(var(--accent-hover))" });
  });

  it("draws the focus ring as an outline that leaves the element's corners alone", () => {
    const ring = declarations(baseLayerRules(root).get(":where(*):focus-visible"));
    expect(ring).toEqual({ outline: "2px solid rgb(var(--accent))", "outline-offset": "2px" });
    expect(ring).not.toHaveProperty("border-radius");
  });
});

describe("compiled stylesheet order", () => {
  /** Index of the first compiled rule with this exact selector (and declaration, if given). */
  function ruleIndex(rules: Rule[], selector: string, decl?: [string, string]): number {
    return rules.findIndex(
      (rule) => rule.selector === selector && (!decl || declarations(rule)[decl[0]] === decl[1]),
    );
  }

  it("emits the link and focus defaults after Preflight and before the utilities they must yield to", async () => {
    const result = await postcss([
      tailwindcss({
        ...tailwindConfig,
        content: [{ raw: '<a class="rounded-full bg-accent text-white hover:bg-accent-hover">Get started</a>' }],
      }),
    ]).process(GLOBALS_CSS, { from: GLOBALS_PATH });
    const rules: Rule[] = [];
    result.root.walkRules((rule) => {
      rules.push(rule);
    });

    const at = {
      preflightLink: ruleIndex(rules, "a", ["color", "inherit"]),
      link: ruleIndex(rules, "a", ["color", "rgb(var(--accent))"]),
      linkHover: ruleIndex(rules, ":where(a):hover"),
      focusRing: ruleIndex(rules, ":where(*):focus-visible"),
      textWhite: ruleIndex(rules, ".text-white"),
      roundedFull: ruleIndex(rules, ".rounded-full"),
    };
    for (const [name, index] of Object.entries(at)) {
      expect(index, `${name} is missing from the compiled CSS`).toBeGreaterThanOrEqual(0);
    }
    // The link colour has to win over Preflight's `a { color: inherit }`…
    expect(at.link).toBeGreaterThan(at.preflightLink);
    // …and the state rules lose to utilities of equal specificity on order.
    expect(at.linkHover).toBeLessThan(at.textWhite);
    expect(at.focusRing).toBeLessThan(at.roundedFull);
  }, 20_000);
});
