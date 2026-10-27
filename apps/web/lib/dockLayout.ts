/** Browser-only layout preferences. No token, message or stream data is stored. */
export const DOCK_LAYOUT_KEY = "sc2t:dock-layout:v1";
export const DOCK_SECTIONS = [
  { id: "dock-chat", label: "Chat" },
  { id: "dock-game", label: "Game" },
  { id: "dock-series", label: "Series" },
  { id: "dock-scout", label: "Scout" },
  { id: "dock-highlight", label: "Highlight" },
  { id: "dock-scenes", label: "Scenes" },
  { id: "dock-build-profile", label: "Build profile" },
  { id: "dock-timer", label: "Timer" },
  { id: "dock-poll", label: "Poll" },
  { id: "dock-goals", label: "Goals" },
  { id: "dock-clips", label: "Clips" },
  { id: "dock-actions", label: "Actions" },
] as const;
export type DockSectionId = typeof DOCK_SECTIONS[number]["id"];
export type DockLayout = { v: 1; collapsed: DockSectionId[]; pinned: DockSectionId[]; brollOpen: boolean };
export const defaultDockLayout = (): DockLayout => ({ v: 1, collapsed: [], pinned: [], brollOpen: false });
const known = new Set<string>(DOCK_SECTIONS.map(section => section.id));
const ids = (raw: unknown): DockSectionId[] => Array.isArray(raw) && raw.length <= DOCK_SECTIONS.length
  ? [...new Set(raw.filter((id): id is DockSectionId => typeof id === "string" && known.has(id)))] : [];

export function normalizeDockLayout(raw: unknown): DockLayout {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as { v?: unknown }).v !== 1) return defaultDockLayout();
  const value = raw as Record<string, unknown>;
  return { v: 1, collapsed: ids(value.collapsed), pinned: ids(value.pinned), brollOpen: value.brollOpen === true };
}
export function readDockLayout(storage: Pick<Storage, "getItem">): DockLayout {
  try { const raw = storage.getItem(DOCK_LAYOUT_KEY); return raw && raw.length > 4096 ? defaultDockLayout() : normalizeDockLayout(raw ? JSON.parse(raw) : null); }
  catch { return defaultDockLayout(); }
}
export function writeDockLayout(storage: Pick<Storage, "setItem">, value: DockLayout): void {
  try { storage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(normalizeDockLayout(value))); }
  catch { /* Storage-denied OBS browsers retain their layout for this visit. */ }
}
export function orderedDockSections(layout: DockLayout): DockSectionId[] {
  return [...layout.pinned, ...DOCK_SECTIONS.map(section => section.id).filter(id => !layout.pinned.includes(id))];
}
