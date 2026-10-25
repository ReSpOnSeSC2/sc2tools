import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import allowlist from "./accessibility-allowlist.json";

type Exception = { page: string; theme: string; project: string; rule: string; target: string; reason: string };
const reviewed = allowlist as Exception[];

/** Exact page/theme/viewport/rule/target exceptions only; no disabled rules. */
export async function checkAccessibility(page: Page, info: TestInfo, route: string, theme: string) {
  await page.evaluate(() => document.fonts.ready);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const issues = result.violations.filter(row => row.impact === "serious" || row.impact === "critical").flatMap(row => row.nodes.map(node => ({
    page: route, theme, project: info.project.name, rule: row.id, target: JSON.stringify(node.target),
    impact: row.impact, summary: node.failureSummary, help: row.helpUrl,
  })));
  await info.attach("accessibility", { body: JSON.stringify({ issues, incomplete: result.incomplete.map(row => row.id) }), contentType: "application/json" });
  if (process.env.A11Y_AUDIT_DIR) {
    const dir = path.resolve(process.env.A11Y_AUDIT_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${info.project.name}-${theme}-${route.replace(/[^a-z0-9]/gi, "_") || "home"}.json`), JSON.stringify(issues, null, 2));
  }
  // Local diagnostic scans cannot disable the CI gate.
  if (process.env.A11Y_COLLECT_ONLY === "1" && !process.env.CI) return;
  const unexpected = issues.filter(issue => !reviewed.some(row => row.reason.trim() && row.page === issue.page && row.theme === issue.theme && row.project === issue.project && row.rule === issue.rule && row.target === issue.target));
  expect(unexpected.map(row => ({ ...row, summary: row.summary?.slice(0, 280) })), `${route} ${theme} serious/critical accessibility regressions`).toEqual([]);
}
