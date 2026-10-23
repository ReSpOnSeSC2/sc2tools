import entries from "../../api/src/data/whatsNew.json";

export type AnnouncementAudience = "website" | "agent" | "stream-studio" | "guides";
export type WhatsNewEntry = { id: string; date: string; title: string; summary: string; audience: AnnouncementAudience; highlights: string[]; helpSlug?: string; agentVersion?: string; major?: boolean };
export const WHATS_NEW = entries as WhatsNewEntry[];
export const WHATS_NEW_CATEGORIES: AnnouncementAudience[] = ["agent", "website", "stream-studio", "guides"];
export const AUDIENCE_LABELS = { agent: "Agent", website: "Website", "stream-studio": "Stream Studio", guides: "Guides" };
export const NEWEST_WHATS_NEW_AT = `${WHATS_NEW[0].date}T00:00:00.000Z`;
export function matchesGoals(entry: WhatsNewEntry, goals?: string[]): boolean {
  return !goals?.length || (entry.audience === "stream-studio" ? goals.includes("stream") : entry.audience === "guides" ? goals.includes("improve") : true);
}
