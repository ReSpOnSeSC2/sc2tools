import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FALLBACK_LATEST_AGENT_VERSION } from "./agentNotice";

export type AgentRelease = {
  version: string;
  date?: string;
  notes: string;
};

const RELEASE_HEADING = /^ ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?: - (\d{4}-\d{2}-\d{2}))?$/;

function parseRelease(section: string): AgentRelease {
  const [heading, ...lines] = section.split("\n");
  const match = RELEASE_HEADING.exec(heading.trimEnd());
  if (!match) throw new Error(`Invalid Agent release heading: ##${heading}`);

  const [, version, date] = match;
  if (!version.split(".").every(part => Number.isSafeInteger(Number(part)))) {
    throw new Error(`Invalid Agent release version: ${version}`);
  }
  if (date) {
    const timestamp = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString().slice(0, 10) !== date) {
      throw new Error(`Invalid date for Agent ${version}: ${date}`);
    }
  }
  const notes = lines.join("\n").trim();
  if (!notes) throw new Error(`Missing release notes for Agent ${version}`);
  return { version, date, notes };
}

function compareVersions(left: string, right: string): number {
  const [leftMajor, leftMinor, leftPatch] = left.split(".").map(Number);
  const [rightMajor, rightMinor, rightPatch] = right.split(".").map(Number);
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch;
}

export function parseAgentChangelog(markdown: string): AgentRelease[] {
  const sections = markdown.replace(/\r\n?/g, "\n").split(/^##(?!#)/m).slice(1);
  // Only a leading draft section is allowed. Every subsequent heading must be a release.
  if (sections[0]?.split("\n", 1)[0].trimEnd() === " [Unreleased]") sections.shift();
  if (!sections.length) throw new Error("The Agent changelog has no version sections");

  const releases = sections.map(parseRelease);
  for (let index = 1; index < releases.length; index += 1) {
    const { version } = releases[index];
    if (compareVersions(releases[index - 1].version, version) <= 0) {
      throw new Error(`Agent changelog versions must be unique and newest first: ${version}`);
    }
  }
  return releases;
}

export function getAgentReleaseNotes(): AgentRelease[] {
  const source = resolve(process.cwd(), "../agent/CHANGELOG.md");
  const releases = parseAgentChangelog(readFileSync(source, "utf8"));
  // The fallback advances after publication and marks where public history starts.
  const latest = releases.findIndex(({ version }) => version === FALLBACK_LATEST_AGENT_VERSION);
  if (latest < 0) throw new Error(`Missing Agent changelog entry for ${FALLBACK_LATEST_AGENT_VERSION}`);
  return releases.slice(latest);
}

export function agentReleaseAnchor(version: string): string {
  return `agent-v${version}`;
}

export function agentReleaseMarkdown(version: string, notes: string): string {
  const gallery = `docs/images/agent-${version}/interface-gallery/README.md`;
  const repository = "https://github.com/ReSpOnSeSC2/sc2tools/blob/main/";
  return notes.replaceAll(`](../../${gallery})`, `](${repository}${gallery})`);
}
