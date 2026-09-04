// @ts-nocheck
"use strict";

const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const {
  CoachingService,
  buildAvailableSlots,
  normalizeAvailability,
} = require("../src/services/coaching");

describe("coaching scheduling", () => {
  test("validates timezone-aware recurring hours", () => {
    expect(normalizeAvailability({
      timeZone: "America/New_York",
      durations: [120, 30, 60, 60],
      windows: [
        { day: 1, start: "09:00", end: "12:00" },
        { day: 1, start: "13:00", end: "17:00" },
      ],
    })).toEqual({
      timeZone: "America/New_York",
      durations: [30, 60, 120],
      windows: [
        { day: 1, startMinute: 540, endMinute: 720 },
        { day: 1, startMinute: 780, endMinute: 1020 },
      ],
    });

    expect(() => normalizeAvailability({
      timeZone: "Not/A_Zone",
      durations: [60],
      windows: [{ day: 1, start: "09:00", end: "10:00" }],
    })).toThrow("valid IANA timezone");

    expect(() => normalizeAvailability({
      timeZone: "UTC",
      durations: [60],
      windows: [
        { day: 1, start: "09:00", end: "12:00" },
        { day: 1, start: "11:30", end: "13:00" },
      ],
    })).toThrow("cannot overlap");
  });

  test("expands coach wall-clock hours to UTC across daylight-saving changes", () => {
    const availability = {
      timeZone: "America/New_York",
      durations: [60],
      windows: [{ day: 1, startMinute: 9 * 60, endMinute: 10 * 60 }],
    };

    const spring = buildAvailableSlots(
      availability,
      [],
      new Date("2026-03-08T12:00:00.000Z"),
    );
    expect(spring[0]).toEqual({
      startAt: "2026-03-09T13:00:00.000Z",
      endAt: "2026-03-09T14:00:00.000Z",
      durationMinutes: 60,
    });

    const fall = buildAvailableSlots(
      availability,
      [],
      new Date("2026-11-01T12:00:00.000Z"),
    );
    expect(fall[0]).toEqual({
      startAt: "2026-11-02T14:00:00.000Z",
      endAt: "2026-11-02T15:00:00.000Z",
      durationMinutes: 60,
    });
  });

  test("does not offer sessions that display outside their wall-clock window across DST", () => {
    const availability = {
      timeZone: "America/New_York",
      durations: [30, 120],
      windows: [{ day: 0, startMinute: 90, endMinute: 240 }],
    };
    const spring = buildAvailableSlots(
      availability,
      [],
      new Date("2026-03-08T04:00:00.000Z"),
    );
    expect(spring).not.toContainEqual({
      startAt: "2026-03-08T06:30:00.000Z",
      endAt: "2026-03-08T08:30:00.000Z",
      durationMinutes: 120,
    });
    expect(spring).toContainEqual({
      startAt: "2026-03-08T07:00:00.000Z",
      endAt: "2026-03-08T07:30:00.000Z",
      durationMinutes: 30,
    });

    const fall = buildAvailableSlots(
      availability,
      [],
      new Date("2026-11-01T04:00:00.000Z"),
    );
    expect(fall).not.toContainEqual({
      startAt: "2026-11-01T05:30:00.000Z",
      endAt: "2026-11-01T06:00:00.000Z",
      durationMinutes: 30,
    });
    expect(fall).toContainEqual({
      startAt: "2026-11-01T07:00:00.000Z",
      endAt: "2026-11-01T07:30:00.000Z",
      durationMinutes: 30,
    });
  });

  describe("persistent calendar", () => {
    let mongo;
    let client;
    let db;
    let service;
    let emits;

    const coachRole = { role: "coach", coachId: "coach-1" };
    const studentOneRole = { role: "student", studentId: "student-1" };
    const studentTwoRole = { role: "student", studentId: "student-2" };

    beforeAll(async () => {
      mongo = await MongoMemoryServer.create();
      client = new MongoClient(mongo.getUri());
      await client.connect();
      const raw = client.db("coaching_schedule_test");
      db = {
        coaching: raw.collection("coaching_locker"),
        users: raw.collection("users"),
        games: raw.collection("games"),
        devicePairings: raw.collection("device_pairings"),
        deviceTokens: raw.collection("device_tokens"),
      };
    });

    afterAll(async () => {
      if (client) await client.close();
      if (mongo) await mongo.stop();
    });

    beforeEach(async () => {
      await Promise.all(Object.values(db).map((collection) => collection.deleteMany({})));
      await db.users.insertMany([
        { userId: "coach-user" },
        { userId: "student-user-1" },
        { userId: "student-user-2" },
        { userId: "platform-admin" },
      ]);
      await db.coaching.insertOne({
        _id: "locker",
        rev: 1,
        state: {
          setup: true,
          coaches: [{ id: "coach-1", name: "Response", userId: "coach-user" }],
          students: [
            { id: "student-1", name: "Alex", userId: "student-user-1", coachId: "coach-1" },
            { id: "student-2", name: "Blair", userId: "student-user-2", coachId: "coach-1" },
          ],
        },
      });
      emits = [];
      service = new CoachingService({
        db,
        io: {
          to(room) {
            return { emit: (event, payload) => emits.push({ room, event, payload }) };
          },
        },
      });
      await service.saveAvailability("coach-user", coachRole, {
        expectedRev: 0,
        timeZone: "America/New_York",
        durations: [30, 60, 120, 180],
        windows: Array.from({ length: 7 }, (_, day) => ({
          day,
          start: "00:00",
          end: "24:00",
        })),
      });
      emits = [];
    });

    test("atomically bootstraps an empty Locker for the platform admin", async () => {
      await db.coaching.deleteMany({});

      const roles = await Promise.all(
        Array.from({ length: 8 }, () => service.roleFor("platform-admin", true)),
      );

      expect(roles).toEqual(Array.from({ length: 8 }, () => ({
        role: "admin",
        coachId: "c1",
        rev: 1,
      })));
      const docs = await db.coaching.find({}).toArray();
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({
        _id: "locker",
        rev: 1,
        state: {
          coaches: [{ id: "c1", name: "ReSpOnSe", userId: "platform-admin" }],
          students: [],
        },
      });
      await expect(service.calendarFor("platform-admin", roles[0], "UTC"))
        .resolves.toMatchObject({
          role: "coach",
          coach: { id: "c1", name: "ReSpOnSe" },
          availability: null,
        });
    });

    test("bootstraps a legacy Locker and assigns only students missing coachId", async () => {
      await db.coaching.deleteMany({});
      await db.coaching.insertOne({
        _id: "locker",
        rev: 7,
        state: {
          coach: "Legacy Coach",
          coaches: [],
          students: [
            { id: "legacy-student", userId: "legacy-user" },
            { id: "explicit-student", userId: "explicit-user", coachId: "preserved-id" },
          ],
        },
      });

      await expect(service.roleFor("platform-admin", true)).resolves.toEqual({
        role: "admin",
        coachId: "c1",
        rev: 8,
      });
      const doc = await db.coaching.findOne({ _id: "locker" });
      expect(doc.state.coaches).toEqual([
        { id: "c1", name: "Legacy Coach", userId: "platform-admin" },
      ]);
      expect(doc.state.students).toEqual([
        { id: "legacy-student", userId: "legacy-user", coachId: "c1" },
        { id: "explicit-student", userId: "explicit-user", coachId: "preserved-id" },
      ]);
    });

    test("does not let an unlinked non-admin claim an empty Locker", async () => {
      await db.coaching.deleteMany({});

      await expect(service.roleFor("ordinary-user", false)).resolves.toEqual({
        role: "none",
        rev: 0,
      });
      await expect(db.coaching.countDocuments({})).resolves.toBe(0);
    });

    test("returns UTC slots that a student client can render in its own local timezone", async () => {
      const calendar = await service.calendarFor(
        "student-user-1",
        studentOneRole,
        "America/Los_Angeles",
      );

      expect(calendar.role).toBe("student");
      expect(calendar.coach).toEqual({ id: "coach-1", name: "Response" });
      expect(calendar.viewerTimeZone).toBe("America/Los_Angeles");
      expect(calendar.availability.timeZone).toBe("America/New_York");
      expect(calendar.availability.enabled).toBe(true);
      expect(calendar.slots.length).toBeGreaterThan(0);
      expect(calendar.slots[0].startAt).toMatch(/Z$/);
    });

    test("atomically allows only one student to claim an overlapping slot", async () => {
      const calendar = await service.calendarFor(
        "student-user-1",
        studentOneRole,
        "UTC",
      );
      const slot = calendar.slots.find((item) => item.durationMinutes === 60);

      const settled = await Promise.allSettled([
        service.bookSession("student-user-1", studentOneRole, slot),
        service.bookSession("student-user-2", studentTwoRole, slot),
      ]);

      expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.find((item) => item.status === "rejected");
      expect(rejected.reason.code).toBe("slot_unavailable");

      const doc = await db.coaching.findOne({ _id: "calendar:coach-1" });
      expect(doc.bookings.filter((item) => item.status === "booked")).toHaveLength(1);
      expect(emits).toHaveLength(1);
      expect(emits[0].room).toBe("user:coach-user");
    });

    test("keeps unread coach alerts durable and marks them read", async () => {
      const calendar = await service.calendarFor(
        "student-user-1",
        studentOneRole,
        "UTC",
      );
      const slot = calendar.slots.find((item) => item.durationMinutes === 30);
      await service.bookSession("student-user-1", studentOneRole, slot);

      const unread = await service.alertSummary("coach-user", coachRole);
      expect(unread.unreadCount).toBe(1);
      expect(unread.alert.title).toBe("New coaching booking");
      expect(unread.alert.message).toContain("Alex");

      const coachCalendar = await service.calendarFor("coach-user", coachRole, "UTC");
      await service.markAlertsRead("coach-user", coachRole, {
        alerts: coachCalendar.unreadAlerts,
      });
      await expect(service.alertSummary("coach-user", coachRole)).resolves.toMatchObject({
        eligible: true,
        unreadCount: 0,
      });
    });

    test("does not clear a cancellation that occurs after the rendered alert snapshot", async () => {
      const calendar = await service.calendarFor("student-user-1", studentOneRole, "UTC");
      const slot = calendar.slots.find((item) => item.durationMinutes === 30);
      const created = await service.bookSession("student-user-1", studentOneRole, slot);
      const rendered = await service.calendarFor("coach-user", coachRole, "UTC");

      await service.cancelSession("student-user-1", studentOneRole, created.booking.id);
      await service.markAlertsRead("coach-user", coachRole, {
        alerts: rendered.unreadAlerts,
      });

      await expect(service.alertSummary("coach-user", coachRole)).resolves.toMatchObject({
        unreadCount: 1,
        alert: { kind: "cancelled" },
      });
    });

    test("a student can mark only their own cancellation alert read", async () => {
      const calendar = await service.calendarFor("student-user-1", studentOneRole, "UTC");
      const slots = calendar.slots.filter((item) => item.durationMinutes === 30);
      const first = await service.bookSession("student-user-1", studentOneRole, slots[0]);
      const second = await service.bookSession("student-user-2", studentTwoRole, slots[1]);
      await service.cancelSession("coach-user", coachRole, first.booking.id);
      await service.cancelSession("coach-user", coachRole, second.booking.id);

      const one = await service.calendarFor("student-user-1", studentOneRole, "UTC");
      await service.markAlertsRead("student-user-1", studentOneRole, {
        alerts: one.unreadAlerts,
      });

      await expect(service.alertSummary("student-user-1", studentOneRole)).resolves.toMatchObject({ unreadCount: 0 });
      await expect(service.alertSummary("student-user-2", studentTwoRole)).resolves.toMatchObject({ unreadCount: 1 });
    });

    test("returns the committed booking when the same request is retried", async () => {
      const calendar = await service.calendarFor("student-user-1", studentOneRole, "UTC");
      const slot = calendar.slots.find((item) => item.durationMinutes === 60);
      const first = await service.bookSession("student-user-1", studentOneRole, slot);
      const retry = await service.bookSession("student-user-1", studentOneRole, slot);
      expect(retry.booking.id).toBe(first.booking.id);
      const doc = await db.coaching.findOne({ _id: "calendar:coach-1" });
      expect(doc.bookings).toHaveLength(1);
    });

    test("fences a stale booking while a student is removed from the roster", async () => {
      const calendar = await service.calendarFor("student-user-1", studentOneRole, "UTC");
      const slot = calendar.slots.find((item) => item.durationMinutes === 30);
      const current = await service.getDoc();
      const next = structuredClone(current.state);
      next.students = next.students.filter((student) => student.id !== "student-1");
      const originalPutState = service.putState.bind(service);
      let staleBookingError = null;
      service.putState = async (...args) => {
        try {
          await service.bookSession("student-user-1", studentOneRole, slot);
        } catch (error) {
          staleBookingError = error;
        }
        return originalPutState(...args);
      };

      await expect(service.putStateWithRosterGuard(next, current.rev)).resolves.toMatchObject({ ok: true });
      expect(staleBookingError).toMatchObject({ code: "slot_unavailable" });
      const stored = await service.getDoc();
      expect(stored.state.students.some((student) => student.id === "student-1")).toBe(false);
    });

    test("revalidates the attached coach when roster removal finishes between reads", async () => {
      const calendar = await service.calendarFor("student-user-1", studentOneRole, "UTC");
      const slot = calendar.slots.find((item) => item.durationMinutes === 30);
      const current = await service.getDoc();
      const next = structuredClone(current.state);
      next.students = next.students.filter((student) => student.id !== "student-1");
      const originalCalendarDoc = service._calendarDoc.bind(service);
      let mutateBeforeCalendarReturn = true;
      service._calendarDoc = async (coachId) => {
        if (mutateBeforeCalendarReturn) {
          mutateBeforeCalendarReturn = false;
          await service.putStateWithRosterGuard(next, current.rev);
        }
        return originalCalendarDoc(coachId);
      };

      await expect(service.bookSession("student-user-1", studentOneRole, slot)).rejects.toMatchObject({
        code: "coach_not_found",
      });
      const doc = await db.coaching.findOne({ _id: "calendar:coach-1" });
      expect(doc.bookings).toHaveLength(0);
    });

    test("blocks roster removal while the student has an active booking", async () => {
      const calendar = await service.calendarFor("student-user-1", studentOneRole, "UTC");
      const slot = calendar.slots.find((item) => item.durationMinutes === 30);
      await service.bookSession("student-user-1", studentOneRole, slot);
      const current = await service.getDoc();
      const next = structuredClone(current.state);
      next.students = next.students.filter((student) => student.id !== "student-1");

      await expect(service.putStateWithRosterGuard(next, current.rev)).rejects.toMatchObject({
        code: "active_bookings",
      });
    });

    test("rejects stale availability edits and can pause new bookings", async () => {
      await service.saveAvailability("coach-user", coachRole, {
        expectedRev: 1,
        timeZone: "America/New_York",
        durations: [60],
        windows: [{ day: 1, start: "09:00", end: "12:00" }],
      });
      await expect(service.saveAvailability("coach-user", coachRole, {
        expectedRev: 1,
        timeZone: "America/New_York",
        durations: [30],
        windows: [{ day: 2, start: "09:00", end: "12:00" }],
      })).rejects.toMatchObject({ code: "availability_conflict" });

      await service.pauseAvailability("coach-user", coachRole, { expectedRev: 2 });
      const paused = await service.calendarFor("student-user-1", studentOneRole, "UTC");
      expect(paused.availability.enabled).toBe(false);
      expect(paused.slots).toEqual([]);
      await expect(service.bookSession("student-user-1", studentOneRole, {
        startAt: "2026-08-25T14:00:00.000Z",
        durationMinutes: 60,
      })).rejects.toMatchObject({ code: "availability_missing" });
    });

    test("blocks calendar and booking writes involving an account under deletion", async () => {
      await db.coaching.deleteOne({ _id: "calendar:coach-1" });
      await db.users.updateOne(
        { userId: "coach-user" },
        { $set: { _gdprMutation: {
          id: "deleting-coach",
          leaseUntil: new Date("2099-01-01T00:00:00.000Z"),
        } } },
      );
      await expect(service.saveAvailability("coach-user", coachRole, {
        expectedRev: 0,
        timeZone: "America/New_York",
        durations: [30],
        windows: [{ day: 1, start: "09:00", end: "12:00" }],
      })).rejects.toMatchObject({
        status: 409,
        code: "account_deletion_in_progress",
      });
      expect(await db.coaching.findOne({ _id: "calendar:coach-1" })).toBeNull();

      await db.users.updateOne(
        { userId: "coach-user" },
        { $unset: { _gdprMutation: "" } },
      );
      await service.saveAvailability("coach-user", coachRole, {
        expectedRev: 0,
        timeZone: "America/New_York",
        durations: [30],
        windows: Array.from({ length: 7 }, (_, day) => ({
          day,
          start: "00:00",
          end: "24:00",
        })),
      });
      const calendar = await service.calendarFor("student-user-1", studentOneRole, "UTC");
      const slot = calendar.slots.find((item) => item.durationMinutes === 30);
      await db.users.updateOne(
        { userId: "student-user-1" },
        { $set: { _gdprMutation: {
          id: "deleting-student",
          leaseUntil: new Date("2099-01-01T00:00:00.000Z"),
        } } },
      );
      await expect(service.bookSession("student-user-1", studentOneRole, slot))
        .rejects.toMatchObject({
          status: 409,
          code: "account_deletion_in_progress",
        });
      expect((await db.coaching.findOne({ _id: "calendar:coach-1" })).bookings)
        .toEqual([]);
    });

    test("students can see only their own bookings", async () => {
      const first = await service.calendarFor("student-user-1", studentOneRole, "UTC");
      const slot = first.slots.find((item) => item.durationMinutes === 30);
      await service.bookSession("student-user-1", studentOneRole, slot);

      const mine = await service.calendarFor("student-user-1", studentOneRole, "UTC");
      const other = await service.calendarFor("student-user-2", studentTwoRole, "UTC");
      expect(mine.bookings).toHaveLength(1);
      expect(other.bookings).toHaveLength(0);
    });

    test("account picker uses active device tokens and collapses duplicate emails", async () => {
      await db.users.insertMany([
        { userId: "old-account", clerkUserId: "old", email: "same@example.com" },
        { userId: "paired-account", clerkUserId: "paired", email: "same@example.com" },
        { userId: "plain-account", clerkUserId: "plain", email: "plain@example.com" },
      ]);
      const lastSeenAt = new Date("2026-08-24T18:00:00.000Z");
      await db.deviceTokens.insertOne({
        tokenHash: "active-token",
        userId: "paired-account",
        revokedAt: null,
        lastSeenAt,
      });
      await db.deviceTokens.insertOne({
        tokenHash: "revoked-token",
        userId: "plain-account",
        revokedAt: new Date(),
        lastSeenAt,
      });

      const users = await service.listUsers("");
      expect(users).toHaveLength(2);
      expect(users.find((user) => user.email === "same@example.com")).toMatchObject({
        userId: "paired-account",
        hasAgent: true,
        agentLastSeen: lastSeenAt.toISOString(),
      });
      expect(users.find((user) => user.email === "plain@example.com").hasAgent).toBe(false);
    });
  });
});
