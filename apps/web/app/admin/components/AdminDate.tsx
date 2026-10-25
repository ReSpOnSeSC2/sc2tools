import { timeSince } from "./format";

/** Relative timestamps always expose an absolute, machine-readable date. */
export function AdminDate({ value }: { value: string | null | undefined }) {
  if (!value || !Number.isFinite(+new Date(value))) return <>—</>;
  const iso = new Date(value).toISOString();
  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{timeSince(iso)}</time>;
}
