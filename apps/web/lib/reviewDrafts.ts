export type ReviewDraft = { body: string; start: number; end: number | null; savedAt: number };

const PREFIX = "sc2tools:review-draft:v1:";
const MAX_AGE = 14 * 24 * 60 * 60 * 1000;
const MAX_DRAFTS = 20;
const keyFor = (requestId: string, parentId: string | null) => `${PREFIX}${requestId}:${parentId ?? "root"}`;

function read(storage: Storage, key: string): ReviewDraft | null | undefined {
  let raw: string | null;
  try { raw = storage.getItem(key); } catch { return undefined; }
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return null;
    const draft = value as Partial<ReviewDraft>;
    return typeof draft.body === "string" && draft.body.trim().length > 0 &&
      typeof draft.start === "number" && Number.isFinite(draft.start) && draft.start >= 0 &&
      (draft.end === null || typeof draft.end === "number" && Number.isFinite(draft.end) && draft.end > draft.start) &&
      typeof draft.savedAt === "number" && Number.isFinite(draft.savedAt) ? draft as ReviewDraft : null;
  } catch { return null; }
}

/** Expired/malformed drafts are removed before the oldest drafts beyond the cap. */
export function pruneDrafts(now = Date.now()): void {
  try {
    const storage = window.localStorage;
    const entries: Array<{ key: string; savedAt: number }> = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      const draft = read(storage, key);
      if (draft === undefined) continue;
      entries.push({ key, savedAt: draft && now - draft.savedAt <= MAX_AGE ? draft.savedAt : -Infinity });
    }
    entries.sort((a, b) => b.savedAt - a.savedAt);
    entries.forEach(({ key, savedAt }, index) => {
      if (savedAt === -Infinity || index >= MAX_DRAFTS) {
        try { storage.removeItem(key); } catch { /* Storage may become unavailable mid-scan. */ }
      }
    });
  } catch { /* Storage is optional, including during server rendering. */ }
}

export function loadDraft(requestId: string, parentId: string | null = null): ReviewDraft | null {
  pruneDrafts();
  try {
    const draft = read(window.localStorage, keyFor(requestId, parentId));
    return draft && Date.now() - draft.savedAt <= MAX_AGE ? draft : null;
  } catch { return null; }
}

export function saveDraft(requestId: string, parentId: string | null, draft: Omit<ReviewDraft, "savedAt">): void {
  if (!draft.body.trim()) { clearDraft(requestId, parentId); return; }
  try { window.localStorage.setItem(keyFor(requestId, parentId), JSON.stringify({ ...draft, savedAt: Date.now() })); } catch { /* Quota/private mode cannot prevent writing a review. */ }
  pruneDrafts();
}

export function clearDraft(requestId: string, parentId: string | null = null): void {
  try { window.localStorage.removeItem(keyFor(requestId, parentId)); } catch { /* Continue without persistence. */ }
}
