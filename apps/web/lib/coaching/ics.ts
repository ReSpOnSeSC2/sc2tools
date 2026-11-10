/**
 * A one-event iCalendar file for "Add to calendar" on a booking card
 * (RFC 5545: CRLF lines folded at 75 octets, escaped text, UTC times).
 * The subscribed feed (/v1/calendar/<secret>.ics) is built by the API.
 */

function escapeText(value: string): string {
  return value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function fold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  let out = ""; let current = ""; let size = 0; let limit = 75;
  for (const ch of line) {
    const width = encoder.encode(ch).length;
    if (size + width > limit) { out += `${current}\r\n `; current = ""; size = 0; limit = 74; }
    current += ch; size += width;
  }
  return out + current;
}

const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function bookingIcs(booking: { id: string; startAt: string; endAt: string }, summary: string, now: Date = new Date()): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SC2 Tools//Coaching//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${escapeText(booking.id)}@sc2tools.com`, `DTSTAMP:${stamp(now.toISOString())}`, `DTSTART:${stamp(booking.startAt)}`, `DTEND:${stamp(booking.endAt)}`,
    `SUMMARY:${escapeText(summary)}`, "DESCRIPTION:Details: https://sc2tools.com/coaching", "URL:https://sc2tools.com/coaching", "STATUS:CONFIRMED", "END:VEVENT", "END:VCALENDAR"];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** Save the file through a temporary object URL; nothing leaves the browser. */
export function downloadIcs(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/calendar;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
