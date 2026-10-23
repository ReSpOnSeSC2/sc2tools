export type AvailabilityWindow = {
  day: number;
  startMinute: number;
  endMinute: number;
};

export type Availability = {
  enabled: boolean;
  timeZone: string;
  durations: number[];
  windows: AvailabilityWindow[];
  updatedAt: string | null;
};

export type Booking = {
  id: string;
  studentName: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  status: "booked" | "cancelled";
  cancelledBy: "coach" | "student" | null;
  createdAt: string;
};

export type Slot = {
  startAt: string;
  endAt: string;
  durationMinutes: number;
};

export type CalendarPayload = {
  role: "coach" | "student";
  coach: { id: string; name: string };
  viewerTimeZone: string;
  availabilityRev: number;
  availability: Availability | null;
  bookings: Booking[];
  unreadAlerts: Array<{ bookingId: string; updatedAt: string }>;
  slots: Slot[];
};

export type AvailabilityDraft = {
  timeZone: string;
  durations: number[];
  windows: AvailabilityWindow[];
};
