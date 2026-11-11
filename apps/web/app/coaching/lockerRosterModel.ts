export type LockerCoach = {
  id: string;
  name: string;
  userId?: string;
  email?: string;
};

export type LockerStudent = Record<string, unknown> & {
  id: string;
  name: string;
  note?: string;
  coachId?: string;
  userId?: string;
  email?: string;
};

export type LockerState = Record<string, unknown> & {
  coaches?: LockerCoach[];
  students?: LockerStudent[];
};

export type LockerDocument = { rev: number; scoped: boolean; state: LockerState };

export type LockerAccount = {
  userId: string;
  clerkUserId: string | null;
  email: string;
  hasAgent: boolean;
};

export function rosterStudents(state: LockerState): LockerStudent[] {
  return Array.isArray(state.students) ? state.students.filter((row) => row && typeof row.id === "string" && typeof row.name === "string") : [];
}

export function rosterCoaches(state: LockerState): LockerCoach[] {
  return Array.isArray(state.coaches) ? state.coaches.filter((row) => row && typeof row.id === "string" && typeof row.name === "string") : [];
}

export function updateRosterStudent(state: LockerState, id: string, patch: Partial<Pick<LockerStudent, "name" | "note" | "coachId">>): LockerState {
  return { ...state, students: (state.students ?? []).map((student) => student?.id === id ? { ...student, ...patch } : student) };
}

export function removeRosterStudent(state: LockerState, id: string): LockerState {
  return { ...state, students: (state.students ?? []).filter((student) => student?.id !== id) };
}

export function addRosterStudent(state: LockerState, id: string, name: string, note: string, coachId: string, account: LockerAccount): LockerState {
  const student = {
    id, name, note, coachId, userId: account.userId, email: account.email,
    builds: [], shelf: [], worksheets: [], submissions: [], intake: { done: false }, focus: null,
    lanes: { active: 0, bridge: 0, historical: 0, quarantine: 0 }, agent: { status: "none" }, games: [],
  };
  return { ...state, students: [...(state.students ?? []), student] };
}

export function addRosterCoach(state: LockerState, id: string, name: string, account: LockerAccount): LockerState {
  const coach = { id, name, pin: null, userId: account.userId, clerkUserId: account.clerkUserId, email: account.email };
  return { ...state, coaches: [...(state.coaches ?? []), coach] };
}

export function removeRosterCoach(state: LockerState, id: string, fallback: string): LockerState {
  return {
    ...state,
    coaches: (state.coaches ?? []).filter((coach) => coach?.id !== id),
    students: (state.students ?? []).map((student) => student?.coachId === id ? { ...student, coachId: fallback } : student),
  };
}
