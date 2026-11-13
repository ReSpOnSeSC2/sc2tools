import { API_BASE } from "@/lib/apiBase";

type DownloadResponse = { url: string; filename: string };

/** Recheck public sharing on click before using a short-lived replay URL. */
export async function downloadPublicReplay(handle: string, gameId: string) {
  const response = await fetch(
    `${API_BASE}/v1/public/replays/${encodeURIComponent(handle)}/${encodeURIComponent(gameId)}/download`,
    { headers: { accept: "application/json" }, cache: "no-store" },
  );
  if (!response.ok) throw new Error(await publicDownloadError(response));
  const payload = (await response.json()) as DownloadResponse;
  const href = safePublicDownloadUrl(payload.url);
  if (!href) throw new Error("The replay download link was invalid.");

  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = safeFilename(payload.filename);
  anchor.rel = "noopener noreferrer";
  anchor.referrerPolicy = "no-referrer";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

async function publicDownloadError(response: Response): Promise<string> {
  if (response.status === 404) {
    return "This replay is unavailable or sharing has been turned off.";
  }
  if (response.status === 429) return "Too many download requests. Try again in a minute.";
  if (response.status >= 500) return "Replay storage is temporarily unavailable.";
  try {
    const body = await response.json() as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // Use the generic message below.
  }
  return "The replay download could not be prepared.";
}

function safePublicDownloadUrl(value: unknown): string | null {
  const path = /^\/v1\/public\/replays\/[a-z0-9-]{1,64}\/r-[a-f0-9]{24}\/file\?token=\d{13}\.[A-Za-z0-9_-]{43}$/;
  return typeof value === "string" && path.test(value) ? API_BASE + value : null;
}

function safeFilename(value: unknown): string {
  const raw = typeof value === "string" ? value : "sc2tools-replay";
  const clean = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\.SC2Replay$/i, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 160);
  return `${clean || "sc2tools-replay"}.SC2Replay`;
}
