"use client";

/** The parts of a Discord webhook message the preview renders. */
export type DiscordEmbed = { title?: string; description?: string; color?: number; url?: string; fields?: Array<{ name: string; value: string; inline?: boolean }> };
export type DiscordMessage = { embeds?: DiscordEmbed[] };
export type DiscordPreview = { kind: "result" | "session" | "weekly" | "milestone"; example: boolean; payload: DiscordMessage };

export const PREVIEW_LABELS: Record<DiscordPreview["kind"], string> = {
  result: "Ranked result", session: "Session summary", weekly: "Weekly recap", milestone: "New MMR peak",
};

/** Discord markdown escapes ("\*") read as plain text here. */
const plain = (value: string | undefined) => (value || "").replace(/\\([\\*_~`|>[\]()#@])/g, "$1");

function accent(color: number | undefined): string {
  const value = typeof color === "number" && color >= 0 ? color : 0x3aa7ff;
  return `rgb(${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255})`;
}

/** A Discord-like card: what the channel will show, with the hook's privacy options applied. */
export function DiscordEmbedPreview({ preview }: { preview: DiscordPreview }) {
  const embed = preview.payload.embeds?.[0];
  if (!embed) return null;
  return <figure className="min-w-0 rounded-lg border border-border bg-bg-elevated/60 p-3">
    <figcaption className="mb-2 text-caption font-semibold text-text-muted">{PREVIEW_LABELS[preview.kind]}{preview.example ? " · example data" : ""}</figcaption>
    <div className="min-w-0 border-l-4 pl-3" style={{ borderLeftColor: accent(embed.color) }}>
      {embed.title ? <p className="break-words text-body font-semibold text-text">{plain(embed.title)}</p> : null}
      {embed.description ? <p className="mt-1 break-words text-caption text-text">{plain(embed.description)}</p> : null}
      {embed.fields?.length ? <dl className="mt-2 grid gap-2 sm:grid-cols-3">{embed.fields.map((field) => <div key={field.name} className={field.inline ? "min-w-0" : "min-w-0 sm:col-span-3"}>
        <dt className="text-caption font-semibold text-text-muted">{plain(field.name)}</dt><dd className="break-words text-caption text-text">{plain(field.value)}</dd>
      </div>)}</dl> : null}
      {embed.url ? <p className="mt-2 break-all text-caption text-text-muted">Links to {embed.url}</p> : null}
    </div>
  </figure>;
}
