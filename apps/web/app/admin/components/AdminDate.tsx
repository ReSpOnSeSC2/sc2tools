import { timeSince } from "./format";
import { formatDateTime } from "@/lib/i18n/format";

/** Relative timestamps always expose an absolute, machine-readable date. */
export function AdminDate({ value }: { value: string | null | undefined }) {
  if (!value || !Number.isFinite(+new Date(value))) return <>—</>;
  const iso = new Date(value).toISOString();
  return <time dateTime={iso} title={formatDateTime(new Date(iso))}>{timeSince(iso)}</time>;
}
