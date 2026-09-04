export type CoachingRole = "admin" | "coach" | "student";
export type AssignmentType = "build" | "total";
export type Recurrence = "once" | "daily" | "weekly" | "monthly";
export type AssignmentStatus = "active" | "cancelled";
export type ProgressState = "upcoming" | "active" | "met" | "missed" | "cancelled";

export type Student = {
  id: string;
  name: string;
  userId?: string | null;
};

export type LockerStatePayload = {
  state?: {
    students?: Student[];
  };
};

export type PracticeGame = {
  gameId: string;
  date: string;
  map: string;
  opponent: string;
  result: string;
  myBuild: string | null;
  isLadderGame: boolean | null;
  matchFormat: string;
  replayAvailable: boolean;
  replayDownloadPath: string | null;
};

export type ProgressBucket = {
  key: string;
  startsAt: string;
  endsAt: string;
  playedGames: number;
  requiredGames: number;
  remainingGames: number;
  complete: boolean;
};

export type PracticeAssignment = {
  id: string;
  rev: number;
  status: AssignmentStatus;
  student: { id: string; name: string };
  coach: { id: string; name: string };
  requirement: {
    type: AssignmentType;
    requiredGames: number;
    recurrence: Recurrence;
    build?: { id: string; name: string; matchBy: "name" | "slug" } | null;
    timeZone: string;
    title?: string | null;
    note?: string | null;
    window: {
      startsOn: string;
      endsOn: string;
      startsAt: string;
      endsAt: string;
      endExclusive: true;
    };
  };
  createdAt: string;
  updatedAt: string;
  progress: {
    state: ProgressState;
    playedGames: number;
    requiredGamesTotal: number;
    completedBuckets: number;
    totalBuckets: number;
    currentBucket: ProgressBucket | null;
    buckets: ProgressBucket[];
    games: PracticeGame[];
    replayGames: PracticeGame[];
    replayGameCount?: number;
    gamesTruncated: boolean;
  };
};

export type AssignmentsPayload = {
  serverTime: string;
  assignments: PracticeAssignment[];
  page?: number;
  limit?: number;
  hasMore?: boolean;
};

export type AssignmentGamesPayload = {
  assignmentId: string;
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  games: PracticeGame[];
};

export type PracticeSharingStatus = "pending" | "accepted" | "rejected" | "revoked";

export type PracticeSharingRelationship = {
  student: { id: string; name: string };
  coach: { id: string; name: string };
  status: PracticeSharingStatus;
  requestedAt: string | null;
  respondedAt: string | null;
  revokedAt: string | null;
  policyVersion: "practice-replays-v1";
  scope: {
    practiceAssignments: true;
    qualifyingOneVsOneGameDetails: true;
    archivedOriginalReplays: true;
  };
};

export type PracticeSharingPayload = {
  rev: number;
  relationships: PracticeSharingRelationship[];
};

export type SlimGame = { b?: string; bid?: string };
export type BuildSuggestion = { id: string; name: string; matchBy: "name" | "slug" };

export type AssignmentDraft = {
  studentId: string;
  type: AssignmentType;
  requiredGames: string;
  buildSelection: string;
  buildName: string;
  recurrence: Exclude<Recurrence, "once">;
  totalRangeInitialized: boolean;
  /** True once the coach directly changes either calendar field. */
  dateRangeEdited: boolean;
  startsOn: string;
  endsOn: string;
  timeZone: string;
  title: string;
  note: string;
  clientRequestId: string;
};

export function buildSuggestionKey(build: BuildSuggestion) {
  const identity = build.matchBy === "slug"
    ? build.id.trim()
    : build.name.trim().toLocaleLowerCase();
  return `${build.matchBy}:${identity}`;
}

export function requirementTitle(assignment: PracticeAssignment) {
  const count = assignment.requirement.requiredGames;
  if (assignment.requirement.type === "build") {
    return `${count} ${assignment.requirement.build?.name || "build"} game${count === 1 ? "" : "s"}`;
  }
  return `${count} game${count === 1 ? "" : "s"} per ${cadenceNoun(assignment.requirement.recurrence)}`;
}

export function requirementDetail(assignment: PracticeAssignment) {
  const count = assignment.requirement.requiredGames;
  if (assignment.requirement.type === "build") {
    return `Play ${count} eligible 1v1 game${count === 1 ? "" : "s"} using ${assignment.requirement.build?.name || "the assigned build"}.`;
  }
  return `Play ${count} eligible 1v1 game${count === 1 ? "" : "s"} each ${cadenceNoun(assignment.requirement.recurrence)}.`;
}

export function cadenceNoun(recurrence: Recurrence) {
  if (recurrence === "daily") return "day";
  if (recurrence === "monthly") return "month";
  if (recurrence === "weekly") return "week";
  return "window";
}

export function progressStateLabel(state: ProgressState) {
  if (state === "met") return "Complete";
  if (state === "missed") return "Window ended";
  if (state === "upcoming") return "Starts soon";
  if (state === "cancelled") return "Cancelled";
  return "In progress";
}

export function statePill(state: ProgressState) {
  const color = state === "met"
    ? "border-success/40 bg-success/10 text-success"
    : state === "missed" || state === "cancelled"
      ? "border-border bg-bg-elevated text-text-dim"
      : state === "upcoming"
        ? "border-warning/40 bg-warning/10 text-warning"
        : "border-accent/40 bg-accent/10 text-accent-cyan";
  return `inline-flex min-h-6 items-center rounded-full border px-2.5 text-micro font-extrabold uppercase tracking-wider ${color}`;
}

export function formatWindow(startsAt: string, endsAtExclusive: string, timeZone: string) {
  const starts = new Date(startsAt);
  const ends = new Date(new Date(endsAtExclusive).getTime() - 1);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) return "Date unavailable";
  const keyFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const startKey = keyFormatter.format(starts);
  const endKey = keyFormatter.format(ends);
  const sameYear = startKey.slice(0, 4) === endKey.slice(0, 4);
  const start = new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(starts);
  const end = new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(ends);
  if (startKey === endKey) return end;
  return `${start}–${end}`;
}

export function formatGameDate(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function localDateKey(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const read = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

export function addDays(key: string, days: number) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function defaultCalendarRange(
  key: string,
  recurrence: AssignmentDraft["recurrence"],
) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (Number.isNaN(date.getTime())) return { startsOn: key, endsOn: key };
  if (recurrence === "daily") return { startsOn: key, endsOn: key };
  if (recurrence === "weekly") {
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    const startsOn = addDays(key, -mondayOffset);
    return { startsOn, endsOn: addDays(startsOn, 6) };
  }
  const startsOn = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
  return { startsOn, endsOn: `${startsOn.slice(0, 8)}${String(lastDay).padStart(2, "0")}` };
}

export function calendarPeriodCount(
  startsOn: string,
  endsOn: string,
  recurrence: AssignmentDraft["recurrence"],
) {
  const startMs = Date.parse(`${startsOn}T12:00:00Z`);
  const endMs = Date.parse(`${endsOn}T12:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
  const keys = new Set<string>();
  for (let at = startMs; at <= endMs; at += 86_400_000) {
    const key = new Date(at).toISOString().slice(0, 10);
    if (recurrence === "daily") keys.add(key);
    else if (recurrence === "monthly") keys.add(key.slice(0, 7));
    else {
      const day = new Date(at).getUTCDay();
      keys.add(addDays(key, -((day + 6) % 7)));
    }
  }
  return keys.size;
}

export function buildId(name: string) {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `build-${requestId()}`;
}

export function requestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `practice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
