import type { PatchEra } from "@/lib/meta";
import registry from "./practiceLinks.json";

export interface PracticeLink {
  alias: string;
  communitySlug: string;
  youtubeId: string;
  creator: string;
  offsetSec: number;
  patchEra: PatchEra;
  gradeEndSec: number;
}

const ALIAS = /^(?=.{2,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PUBLIC_BUILD = /^build-[0-9a-f]{32}$/;
const VIDEO = /^[A-Za-z0-9_-]{11}$/;
const RESERVED = new Set(["weekly"]);

function seconds(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= 14_400;
}

function isPracticeLink(input: unknown): input is PracticeLink {
  if (!input || typeof input !== "object") return false;
  const link = input as Partial<PracticeLink>;
  return typeof link.alias === "string" && ALIAS.test(link.alias) && !RESERVED.has(link.alias)
    && typeof link.communitySlug === "string" && PUBLIC_BUILD.test(link.communitySlug)
    && typeof link.youtubeId === "string" && VIDEO.test(link.youtubeId)
    && typeof link.creator === "string" && link.creator.trim() === link.creator && link.creator.length > 0
    && link.creator.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(link.creator)
    && seconds(link.offsetSec, 0) && seconds(link.gradeEndSec, 1)
    && (link.patchEra === "before" || link.patchEra === "after");
}

export function readPracticeLinks(input: unknown): readonly PracticeLink[] {
  if (!Array.isArray(input)) throw new Error("Practice Links must be an array.");
  const aliases = new Set<string>();
  const builds = new Set<string>();
  return input.map((link: unknown) => {
    if (!isPracticeLink(link)) throw new Error("Invalid Practice Link entry.");
    if (aliases.has(link.alias) || builds.has(link.communitySlug)) throw new Error("Duplicate Practice Link entry.");
    aliases.add(link.alias);
    builds.add(link.communitySlug);
    return link;
  });
}

export const practiceLinks = readPracticeLinks(registry);
export const practiceLinkByAlias = (alias: string) => practiceLinks.find((link) => link.alias === alias);
export const practiceLinkByBuild = (slug: string, creator: string | undefined) =>
  practiceLinks.find((link) => link.communitySlug === slug && link.creator === creator);
export const practiceLinkPath = (link: Pick<PracticeLink, "alias">): `/b/${string}` => `/b/${link.alias}`;
