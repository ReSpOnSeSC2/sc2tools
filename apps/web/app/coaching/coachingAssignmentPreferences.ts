import { validTimeZone } from "./coachingPracticeModel";

const zoneKey = (studentId: string) => `sc2tools:coaching:tz:${studentId}`;

export function assignmentTimeZone(studentId: string, browserZone: string) {
  try {
    const remembered = localStorage.getItem(zoneKey(studentId));
    if (remembered && validTimeZone(remembered)) return remembered;
  } catch { /* Storage can be unavailable in private browsing. */ }
  return validTimeZone(browserZone) ? browserZone : "UTC";
}

export function rememberAssignmentTimeZone(studentId: string, zone: string) {
  if (!studentId || !validTimeZone(zone)) return;
  try { localStorage.setItem(zoneKey(studentId), zone); } catch { /* Assigning still works without storage. */ }
}
