import assert from "node:assert/strict";
import test from "node:test";
import { aggregateViolations, analyzeSource, compareBaseline, validateBaseline } from "./rules.mjs";

const analyze = (source, file = "components/example.tsx") => analyzeSource(file, source);
const rules = (source, file) => analyze(source, file).map((violation) => violation.rule);

test("native global and member calls, aliases and computed properties are caught", () => {
  const source = `confirm('Delete?'); window.prompt('Copy'); globalThis['confirm']('Proceed?');
    const ask = self.confirm; const { prompt: nativePrompt } = window;`;
  assert.equal(rules(source).filter((rule) => rule === "native-confirm-prompt").length, 5);
});

test("local useConfirm result, parameters, imports and lexical shadowing stay valid", () => {
  assert.deepEqual(rules(`import { prompt } from './editor'; prompt();
    function Editor() { const { confirm } = useConfirm(); return confirm({ title: 'Continue?' }); }
    function parse(confirm) { return confirm(); }
    function scoped(window) { return window.confirm(); }`), []);
  assert.equal(rules(`for (const confirm of callbacks) { confirm(); } confirm();`).length, 1);
  assert.equal(rules(`function nested() { var prompt = action; prompt(); } prompt();`).length, 1);
});

test("comments and prose mentioning native dialogs are not calls", () => {
  assert.deepEqual(rules(`// window.confirm('x')
    const documentation = "Use confirm('x') in this example";`), []);
});

test("dialog roles are owned by UI primitives, including object props", () => {
  const source = `const props = { role: 'dialog' }; const node = <aside role={'alertdialog'} />;`;
  assert.deepEqual(rules(source), ["dialog-outside-ui", "dialog-outside-ui"]);
  assert.deepEqual(rules(source, "components/ui/Modal.tsx"), []);
  assert.deepEqual(rules(`<div role="status" />`), []);
});

test("outline removal requires an actual width ring in the same static class", () => {
  assert.deepEqual(rules(`<input className="focus:outline-none focus-visible:ring-2 focus-visible:ring-accent" />`), []);
  assert.deepEqual(rules(`<input className="focus:outline-none ring-offset-2" />`), ["focus-without-ring"]);
  assert.deepEqual(rules(`<input className="outline-none ring-0" />`), ["focus-without-ring"]);
  assert.deepEqual(rules(`<input className="outline-none ring-0 focus-visible:ring-2" />`), []);
  assert.deepEqual(rules(`<input className={busy ? 'outline-none' : 'ring-2'} />`), ["focus-without-ring"]);
});

test("arbitrary text below 12px is rejected in px and rem, including template segments", () => {
  const source = 'const cls = `text-[10px] ${tone} lg:text-[.7rem]`; const good = "text-[12px] text-[0.75rem]";';
  assert.deepEqual(rules(source), ["small-arbitrary-text", "small-arbitrary-text"]);
  assert.deepEqual(rules(`const name = "text-[length:11px]";`), ["small-arbitrary-text"]);
});

test("hex colors use only explicit visualization exceptions", () => {
  const source = `const colors = ['#fff', '#abcd', '#aabbcc', '#aabbccdd'];`;
  assert.equal(rules(source).filter((rule) => rule === "hex-outside-visualization").length, 4);
  assert.deepEqual(rules(source, "components/overlay/widgets/Example.tsx"), []);
  assert.deepEqual(rules(source, "components/analyzer/charts/Example.tsx"), []);
  assert.equal(rules(source, "components/unrelated-chart/Example.tsx").length, 4);
  assert.deepEqual(rules(`const anchors = ['#app', '#abcde', '#abcdefgh'];`), []);
});

test("fragment IDs, URLs and SVG filter references are not mistaken for colors", () => {
  assert.deepEqual(rules(`<a id="abc" href="#abc" aria-controls="fade">Go</a>;
    const href = '#fade'; const asset = 'https://example.invalid/#abc';
    const svg = <path fill="url(#abc)" />; const css = '#abc:hover { color: var(--text) }';`), []);
  assert.deepEqual(rules('const link = <a href={`#abc${suffix}`} />; const svg = "url(\'#fade\')";'), []);
  assert.deepEqual(rules(`const color = '#abc'; const css = '#abc { color: #fff; }';`),
    ["hex-outside-visualization", "hex-outside-visualization"]);
});

test("visualization exceptions never waive focus or dialog violations", () => {
  assert.deepEqual(rules(`<div role="dialog" className="outline-none" />`, "components/overlay/Example.tsx"), ["dialog-outside-ui", "focus-without-ring"]);
});

test("hand-rolled link buttons resolve local class constants and require link elements", () => {
  const source = `const CTA = "hard-press rounded-full bg-accent";
    const primary = <Link className={CTA} href="/app">Go</Link>;
    const secondary = <a className="rounded-lg bg-accent" href="/app">Go</a>;
    const okay = <Button className="rounded-lg bg-accent">Go</Button>;`;
  assert.deepEqual(rules(source, "app/page.tsx"), ["handrolled-link-button", "handrolled-accent-link"]);
  assert.deepEqual(rules(source, "components/ui/Button.tsx"), []);
  assert.deepEqual(rules(`<a className="rounded-lg bg-accent" />`, "components/dense/Example.tsx"), []);
});

test("local class constants resolve in their lexical scope", () => {
  assert.deepEqual(rules(`const CTA = 'hard-press rounded-full';
    function First() { const CTA = 'text-accent'; return <Link className={CTA} />; }
    function Second() { return <Link className={CTA} />; }`), ["handrolled-link-button"]);
});

test("signatures ignore comments, line numbers, formatting and literal quote style", () => {
  const first = analyze(`window.confirm("Delete?");`)[0];
  const second = analyze(`\n\n // comment\n window . confirm ( 'Delete?' ) ;`)[0];
  assert.equal(first.signature, second.signature);
  assert.notEqual(first.line, second.line);
  assert.notEqual(first.signature, analyze(`window.confirm('Different action?');`)[0].signature);
});

test("dialog signatures include their element context", () => {
  assert.notEqual(analyze(`<div role="dialog" aria-label="One" />`)[0].signature,
    analyze(`<div role="dialog" aria-label="Two" />`)[0].signature);
});

test("ratchet counts identical occurrences and cannot transfer file or rule allowances", () => {
  const baseline = aggregateViolations(analyze(`confirm('x');`));
  assert.equal(compareBaseline(aggregateViolations(analyze(`confirm('x'); confirm('x');`)), baseline).added.length, 1);
  assert.equal(compareBaseline(aggregateViolations(analyze(`confirm('x');`, "app/another.tsx")), baseline).added.length, 1);
  assert.equal(compareBaseline([], baseline).stale.length, 1);
  assert.deepEqual(compareBaseline(baseline, baseline), { added: [], stale: [] });
});

test("malformed and duplicate baseline allowances fail closed", () => {
  const [entry] = aggregateViolations(analyze(`confirm('x');`));
  assert.doesNotThrow(() => validateBaseline([entry]));
  assert.throws(() => validateBaseline([entry, entry]), /duplicate/);
  assert.throws(() => validateBaseline([{ ...entry, count: -1 }]), /malformed/);
  assert.throws(() => validateBaseline([{ ...entry, signature: '*' }]), /malformed/);
  assert.throws(() => validateBaseline([{ ...entry, file: 'components/../elsewhere.tsx' }]), /malformed/);
  assert.throws(() => validateBaseline([{ ...entry, rule: 'all-rules' }]), /malformed/);
});
