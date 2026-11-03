"use strict";

const USER_SCOPED_COLLECTIONS = [
  // (db key, file/json key)
  ["games", "games"],
  ["opponents", "opponents"],
  ["opponentNotes", "opponentNotes"],
  ["customBuilds", "customBuilds"],
  ["overlayTokens", "overlayTokens"],
  ["deviceTokens", "deviceTokens"],
  ["importJobs", "importJobs"],
  ["macroJobs", "macroJobs"],
  ["profiles", "profiles"],
];

/** Keep a related party identifiable without exporting their private Locker record. */
function publicCoachingParty(/** @type {any} */ party) {
  if (!party || typeof party !== "object") return null;
  return {
    id: typeof party.id === "string" ? party.id : null,
    name: typeof party.name === "string" ? party.name : null,
  };
}

/** A coach's DSAR may describe the relationship, never the student's full profile. */
function publicCoachedStudent(/** @type {any} */ student) {
  const sharing = student?.practiceSharing && typeof student.practiceSharing === "object"
    ? student.practiceSharing
    : null;
  return {
    ...publicCoachingParty(student),
    coachId: typeof student?.coachId === "string" ? student.coachId : null,
    practiceSharing: sharing ? {
      policyVersion: typeof sharing.policyVersion === "string" ? sharing.policyVersion : null,
      status: typeof sharing.status === "string" ? sharing.status : null,
      requestedAt: sharing.requestedAt || null,
      respondedAt: sharing.respondedAt || null,
      revokedAt: sharing.revokedAt || null,
    } : null,
  };
}

/**
 * Remove relationship secrets and the other party's internal account id.
 * @param {any} assignment @param {string} userId
 */
function exportedCoachingAssignment(assignment, userId) {
  const exported = { ...assignment };
  delete exported.practiceSharingGrantId;
  if (exported.studentUserId !== userId) delete exported.studentUserId;
  if (exported.coachUserId !== userId) delete exported.coachUserId;
  if (exported.createdByUserId !== userId) delete exported.createdByUserId;
  return exported;
}

/**
 * Export only scheduling data belonging to the caller, with shared ids redacted.
 * @param {any} calendar @param {string} userId
 */
function exportedCoachingCalendar(calendar, userId) {
  const ownsCalendar = calendar?.coachUserId === userId;
  const allBookings = Array.isArray(calendar?.bookings) ? calendar.bookings : [];
  const bookings = (ownsCalendar
    ? allBookings
    : allBookings.filter((/** @type {any} */ booking) => booking?.studentUserId === userId))
    .map((/** @type {any} */ booking) => {
      const exported = { ...booking };
      if (exported.studentUserId !== userId) delete exported.studentUserId;
      return exported;
    });
  if (!ownsCalendar) {
    return {
      role: "student",
      calendar: {
        coachId: calendar?.coachId || null,
        coachName: calendar?.coachName || null,
        bookings,
      },
    };
  }
  const exported = { ...calendar, bookings };
  return { role: "coach", calendar: exported };
}

module.exports = { USER_SCOPED_COLLECTIONS, publicCoachingParty, publicCoachedStudent, exportedCoachingAssignment, exportedCoachingCalendar };
