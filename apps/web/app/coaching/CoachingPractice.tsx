"use client";

import { useAuth } from "@clerk/nextjs";
import {
  CircleDot,
  ListChecks,
  Plus,
  ShieldCheck,
  Target,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { AssignmentModal } from "./AssignmentModal";
import { AssignmentCard } from "./AssignmentCard";
import { PracticeSharingPanel } from "./PracticeSharingPanel";
import { PracticeRoster } from "./PracticeRoster";
import { assignmentTimeZone, rememberAssignmentTimeZone } from "./coachingAssignmentPreferences";
import { useToast } from "@/components/ui/Toast";
import { apiCall, useApi } from "@/lib/clientApi";
import { useUserSocket } from "@/lib/useUserSocket";
import {
  apiMessage,
  useLocalTimeZone,
} from "./coachingTime";
import {
  addDays,
  buildId,
  buildSuggestionKey,
  localDateKey,
  nextWindowDraft,
  requestId,
  requirementTitle,
  validateAssignmentDraft,
  type AssignmentDraft,
  type AssignmentFilter,
  type AssignmentsPayload,
  type BuildSuggestion,
  type CoachingRole,
  type LockerStatePayload,
  type PracticeAssignment,
  type PracticeSharingPayload,
  type SlimGame,
} from "./coachingPracticeModel";

export default function CoachingPractice({ role }: { role: CoachingRole }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  return isLoaded && isSignedIn && userId ? <PracticeWorkspace key={userId} role={role} /> : <PracticeSkeleton />;
}

function PracticeWorkspace({ role }: { role: CoachingRole }) {
  const canManage = role === "admin" || role === "coach";
  const timeZone = useLocalTimeZone();
  const roster = useApi<LockerStatePayload>(canManage ? "/v1/coaching/state" : null);
  const sharing = useApi<PracticeSharingPayload>("/v1/coaching/practice-sharing", {
    revalidateOnFocus: true,
    refreshInterval: 30_000,
  });
  const [studentId, setStudentId] = useState("");
  const [assignmentPage, setAssignmentPage] = useState(1);
  const [stateFilter, setStateFilter] = useState<AssignmentFilter | null>(null);
  const allPlayers = canManage && !studentId;
  const filterQuery = (stateFilter ?? "active") === "all" ? "" : `&state=${stateFilter ?? "active"}`;
  const selectedSharing = sharing.data?.relationships.find(
    (relationship) => relationship.student.id === studentId,
  ) || null;
  const practiceRelationship = canManage
    ? selectedSharing
    : sharing.data?.relationships[0] || null;
  const assignmentsPath = canManage
    ? (allPlayers ? "/v1/coaching/assignments?state=active&limit=100" : studentId && selectedSharing?.status === "accepted"
      ? `/v1/coaching/assignments?studentId=${encodeURIComponent(studentId)}&page=${assignmentPage}&limit=20${filterQuery}`
      : null)
    : `/v1/coaching/assignments?page=${assignmentPage}&limit=20${filterQuery}`;
  const assignments = useApi<AssignmentsPayload>(assignmentsPath, {
    revalidateOnFocus: true,
    refreshInterval: 30_000,
    keepPreviousData: false,
  }, { timeoutMs: 20_000 });
  const now = assignments.data?.serverTime ? Date.parse(assignments.data.serverTime) : Date.now();
  const students = useMemo(
    () => (roster.data?.state?.students || []).filter((student) => student?.id),
    [roster.data],
  );
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<AssignmentDraft | null>(null);
  const [cancelTarget, setCancelTarget] = useState<PracticeAssignment | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [sharingBusy, setSharingBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const previousCounts = useRef<Map<string, number> | null>(null);
  const { getToken: authToken } = useAuth();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const getToken = useCallback(async () => { if (!mounted.current) throw new Error("Account changed."); const token = await authToken(); if (!mounted.current) throw new Error("Account changed."); return token; }, [authToken]);
  const { toast } = useToast();

  const selectedRosterStudent = students.find((student) => student.id === studentId) || null;
  const linkedStudents = useMemo(
    () => students.filter((student) => Boolean(student.userId)),
    [students],
  );
  const assignableStudents = useMemo(() => {
    const accepted = new Set(
      (sharing.data?.relationships || [])
        .filter((relationship) => relationship.status === "accepted")
        .map((relationship) => relationship.student.id),
    );
    return linkedStudents.filter((student) => accepted.has(student.id));
  }, [linkedStudents, sharing.data]);
  const canAssignSelected = Boolean(
    allPlayers ? assignableStudents.length > 0 : selectedRosterStudent?.userId && selectedSharing?.status === "accepted",
  );
  const assignmentDisabledReason = !selectedRosterStudent
    ? "Select a student first"
    : !selectedRosterStudent.userId
      ? "Link this student's SC2 Tools account in Locker first"
      : selectedSharing?.status !== "accepted"
        ? "The student must approve practice and replay sharing before you can assign games"
        : null;

  const closeAssignmentModal = useCallback(() => {
    if (!saving) setDraft(null);
  }, [saving]);
  const closeCancelDialog = useCallback(() => {
    if (!cancelling) setCancelTarget(null);
  }, [cancelling]);
  const closeRevokeDialog = useCallback(() => {
    if (!sharingBusy) setConfirmRevoke(false);
  }, [sharingBusy]);

  useEffect(() => {
    if (studentId && !students.some((student) => student.id === studentId)) setStudentId("");
  }, [studentId, students]);

  useEffect(() => {
    if (!allPlayers && stateFilter === null && assignments.data?.counts) setStateFilter(assignments.data.counts.active > 0 ? "active" : "all");
  }, [allPlayers, stateFilter, assignments.data?.counts]);

  const visibleAssignments = useMemo(() => {
    const rows = assignments.data?.assignments || [];
    if (!canManage || !studentId) return rows;
    return rows.filter((assignment) => assignment.student.id === studentId);
  }, [assignments.data, canManage, studentId]);

  const refreshAssignments = assignments.mutate;
  const refreshSharing = sharing.mutate;
  const socketHandlers = useMemo(
    () => ({
      "games:changed": () => void refreshAssignments(),
      "coaching:assignment": () => {
        void refreshAssignments();
        void refreshSharing();
      },
    }),
    [refreshAssignments, refreshSharing],
  );
  useUserSocket(socketHandlers);

  const requestPracticeSharing = async () => {
    if (!selectedRosterStudent || !sharing.data) return;
    setSharingBusy(true);
    try {
      await apiCall(
        getToken,
        `/v1/coaching/students/${encodeURIComponent(selectedRosterStudent.id)}/practice-sharing/request`,
        {
          method: "POST",
          body: JSON.stringify({ expectedRev: sharing.data.rev }),
        },
      );
      if (!mounted.current) return;
      await sharing.mutate();
      if (!mounted.current) return;
      toast.success("Practice sharing request sent", {
        description: `${selectedRosterStudent.name} can review it in Coaching.`,
      });
    } catch (error) {
      if (!mounted.current) return;
      await sharing.mutate();
      if (!mounted.current) return;
      toast.error("Request was not sent", { description: apiMessage(error) });
    } finally {
      setSharingBusy(false);
    }
  };

  const respondPracticeSharing = async (decision: "accepted" | "rejected") => {
    if (!practiceRelationship || !sharing.data) return;
    setSharingBusy(true);
    try {
      await apiCall(getToken, "/v1/coaching/practice-sharing/respond", {
        method: "POST",
        body: JSON.stringify({
          expectedRev: sharing.data.rev,
          coachId: practiceRelationship.coach.id,
          decision,
        }),
      });
      if (!mounted.current) return;
      await Promise.all([sharing.mutate(), assignments.mutate()]);
      if (!mounted.current) return;
      toast.success(decision === "accepted" ? "Practice sharing enabled" : "Request declined");
    } catch (error) {
      if (!mounted.current) return;
      await sharing.mutate();
      if (!mounted.current) return;
      toast.error("Your choice was not saved", { description: apiMessage(error) });
    } finally {
      setSharingBusy(false);
    }
  };

  const revokePracticeSharing = async () => {
    if (!practiceRelationship || !sharing.data) return;
    setSharingBusy(true);
    try {
      await apiCall(getToken, "/v1/coaching/practice-sharing/revoke", {
        method: "POST",
        body: JSON.stringify({
          expectedRev: sharing.data.rev,
          coachId: practiceRelationship.coach.id,
        }),
      });
      if (!mounted.current) return;
      setConfirmRevoke(false);
      await Promise.all([sharing.mutate(), assignments.mutate()]);
      if (!mounted.current) return;
      toast.success("Practice sharing revoked", {
        description: "Your coach can no longer open assignment evidence or replays.",
      });
    } catch (error) {
      if (!mounted.current) return;
      setConfirmRevoke(false);
      await sharing.mutate();
      if (!mounted.current) return;
      toast.error("Access was not revoked", { description: apiMessage(error) });
    } finally {
      setSharingBusy(false);
    }
  };

  useEffect(() => {
    const rows = assignments.data?.assignments;
    if (!rows) return;
    const next = new Map(rows.map((assignment) => [
      assignment.id,
      assignment.progress.playedGames,
    ]));
    const previous = previousCounts.current;
    previousCounts.current = next;
    if (canManage || !previous) return;
    for (const assignment of rows) {
      const before = previous.get(assignment.id);
      const after = assignment.progress.playedGames;
      if (before === undefined || after <= before) continue;
      const gained = after - before;
      toast.success(`${gained} game${gained === 1 ? "" : "s"} counted`, {
        description: `${requirementTitle(assignment)} · ${after} recorded so far.`,
      });
    }
  }, [assignments.data, canManage, toast]);

  const suggestionStudentId = draft?.studentId || studentId;
  const selectedStudent = students.find((student) => student.id === suggestionStudentId) || null;
  const observedGames = useApi<{ games: SlimGame[] }>(
    canManage && draft && selectedStudent?.userId
      ? `/v1/coaching/students/${encodeURIComponent(selectedStudent.userId)}/games`
      : null,
    { keepPreviousData: false }, { timeoutMs: 20_000 },
  );
  const buildSuggestions = useMemo(() => {
    const byIdentity = new Map<string, BuildSuggestion>();
    const add = (
      nameValue: unknown,
      idValue: unknown,
      matchBy: BuildSuggestion["matchBy"],
    ) => {
      const name = typeof nameValue === "string" ? nameValue.trim() : "";
      if (!name || /unclassified|game too short/i.test(name)) return;
      const id = typeof idValue === "string" ? idValue.trim() : "";
      const suggestion = { id, name, matchBy };
      const key = buildSuggestionKey(suggestion);
      if (!byIdentity.has(key)) byIdentity.set(key, suggestion);
    };
    for (const game of observedGames.data?.games || []) {
      const id = typeof game.bid === "string" ? game.bid.trim() : "";
      add(game.b, id, id ? "slug" : "name");
    }
    return Array.from(byIdentity.values())
      .sort((a, b) => a.name.localeCompare(b.name) || a.matchBy.localeCompare(b.matchBy))
      .slice(0, 100);
  }, [observedGames.data]);

  useEffect(() => {
    if (!draft || !observedGames.data || observedGames.isPreviousData || observedGames.isLoading || !draft.buildSelection || draft.buildSelection === "manual") return;
    if (!buildSuggestions.some(build => buildSuggestionKey(build) === draft.buildSelection)) setDraft({ ...draft, buildSelection: "", buildName: "", unavailableBuild: true });
  }, [draft, observedGames.data, observedGames.isPreviousData, observedGames.isLoading, buildSuggestions]);

  const openCreate = () => {
    const student = selectedRosterStudent || assignableStudents[0];
    if (!student?.userId) {
      toast.error("Link this student's SC2 Tools account first.");
      return;
    }
    if (!assignableStudents.some((candidate) => candidate.id === student.id)) {
      toast.error("The student must approve practice and replay sharing first.");
      return;
    }
    const playerTimeZone = assignmentTimeZone(student.id, timeZone);
    const today = localDateKey(new Date(), playerTimeZone);
    setDraft({
      studentId: student.id,
      type: "build",
      requiredGames: "5",
      buildSelection: "manual",
      buildName: "",
      recurrence: "weekly",
      totalRangeInitialized: false,
      dateRangeEdited: false,
      startsOn: today,
      endsOn: addDays(today, 6),
      timeZone: playerTimeZone,
      title: "",
      note: "",
      clientRequestId: requestId(),
    });
  };

  const openAgain = (assignment: PracticeAssignment) => {
    if (!assignableStudents.some(student => student.id === assignment.student.id)) return;
    const today = localDateKey(new Date(now), assignment.requirement.timeZone);
    setDraft({ ...nextWindowDraft(assignment, today), clientRequestId: requestId() });
  };

  const saveAssignment = async () => {
    if (!draft) return;
    const requiredGames = Number(draft.requiredGames);
    if (Object.keys(validateAssignmentDraft(draft, { assignableStudents, buildOptions: buildSuggestions })).length) return;
    const selectedBuild = draft.type === "build" && draft.buildSelection !== "manual"
      ? buildSuggestions.find((item) => buildSuggestionKey(item) === draft.buildSelection)
      : undefined;

    setSaving(true);
    try {
      const buildName = draft.buildName.trim();
      const detectedBuild = selectedBuild;
      const resolvedBuildName = detectedBuild?.name || buildName;
      await apiCall(
        getToken,
        `/v1/coaching/students/${encodeURIComponent(draft.studentId)}/assignments`,
        {
          method: "POST",
          body: JSON.stringify({
            clientRequestId: draft.clientRequestId,
            type: draft.type,
            requiredGames,
            ...(draft.type === "build"
              ? {
                build: {
                  id: detectedBuild?.id || buildId(buildName),
                  name: resolvedBuildName,
                  matchBy: detectedBuild?.matchBy || "name",
                },
              }
              : {}),
            recurrence: draft.type === "build" ? "once" : draft.recurrence,
            timeZone: draft.timeZone,
            startsOn: draft.startsOn,
            endsOn: draft.endsOn,
            ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
            ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
          }),
        },
      );
      if (!mounted.current) return;
      rememberAssignmentTimeZone(draft.studentId, draft.timeZone);
      setDraft(null);
      setStudentId(draft.studentId);
      setAssignmentPage(1);
      setStateFilter("active");
      await assignments.mutate();
      if (!mounted.current) return;
      toast.success("Practice plan assigned", {
        description: "Eligible 1v1 games and archived replays will appear automatically.",
      });
    } catch (error) {
      if (!mounted.current) return;
      toast.error("Practice plan was not saved", { description: apiMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const cancelAssignment = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      const assignment = cancelTarget;
      await apiCall(
        getToken,
        `/v1/coaching/assignments/${encodeURIComponent(assignment.id)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            expectedRev: assignment.rev,
            status: "cancelled",
          }),
        },
      );
      if (!mounted.current) return;
      setCancelTarget(null);
      await assignments.mutate();
      if (!mounted.current) return;
      toast.success("Practice plan cancelled");
    } catch (error) {
      if (!mounted.current) return;
      await assignments.mutate();
      if (!mounted.current) return;
      setCancelTarget(null);
      toast.error("Practice plan was not cancelled", { description: apiMessage(error) });
    } finally {
      setCancelling(false);
    }
  };

  const loading = (assignments.isLoading && !assignments.data)
    || (canManage && roster.isLoading && !roster.data)
    || (sharing.isLoading && !sharing.data);
  if (loading) return <PracticeSkeleton />;

  if (assignments.error || sharing.error || (canManage && roster.error)) {
    return (
      <Card>
        <div className="py-10 text-center">
          <h2 className="font-display text-h4 font-extrabold text-text">
            Practice plans could not load
          </h2>
          <p className="mt-2 text-body text-text-muted">
            {assignments.error?.message || sharing.error?.message || roster.error?.message}
          </p>
          <Button
            className="mt-5"
            onClick={() => void (canManage
              ? Promise.all([assignments.mutate(), roster.mutate(), sharing.mutate()])
              : Promise.all([assignments.mutate(), sharing.mutate()]))}
          >
            Try again
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Card variant="feature" className="relative">
        <div className="grid gap-5 p-1 sm:grid-cols-[1fr_auto] sm:items-center">
          <div className="flex min-w-0 items-start gap-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border-2 border-line bg-accent/15 text-accent-cyan shadow-hard">
              <Target className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <p className="text-micro font-extrabold uppercase tracking-[0.14em] text-accent-cyan">
                Practice accountability
              </p>
              <h2 className="mt-1 font-display text-h3 font-extrabold text-text">
                {canManage ? "Assign the games. Keep the evidence." : "Your assigned games, live."}
              </h2>
              <p className="mt-1 max-w-2xl text-body text-text-muted">
                Only real 1v1 replays count—ladder or custom. Team games, FFA,
                and resumed replay branches are excluded automatically.
              </p>
              {!canManage ? (
                <p className="mt-2 max-w-2xl text-caption text-text-dim">
                  Your coach can see each qualifying game’s map, opponent, result,
                  detected build, and archived replay for review.
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <span className="inline-flex min-h-9 items-center gap-2 rounded-full border border-success/40 bg-success/10 px-3 text-caption font-bold text-success">
              <ShieldCheck className="h-4 w-4" aria-hidden />
              Verified 1v1 only
            </span>
            {canManage && students.length > 0 ? (
              <Button
                iconLeft={<Plus className="h-4 w-4" />}
                onClick={openCreate}
                disabled={!canAssignSelected}
                title={assignmentDisabledReason || undefined}
              >
                Assign games
              </Button>
            ) : null}
          </div>
        </div>
      </Card>

      {canManage && students.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Field label="Player" className="min-w-52">
            <Select
              value={studentId}
              onChange={(event) => {
                setStudentId(event.target.value);
                setAssignmentPage(1);
                setStateFilter(null);
              }}
              aria-label="Practice plan player"
            >
              <option value="">All players</option>
              {students.map((student) => (
                <option key={student.id} value={student.id}>{student.name}</option>
              ))}
            </Select>
          </Field>
          <p className="text-caption text-text-dim" role="status">
            {canAssignSelected
              ? "Progress refreshes as the desktop agent syncs each replay."
              : assignmentDisabledReason}
          </p>
        </div>
      ) : null}

      <PracticeSharingPanel
        canManage={canManage}
        relationship={practiceRelationship}
        selectedStudent={selectedRosterStudent}
        busy={sharingBusy}
        onRequest={() => void requestPracticeSharing()}
        onRespond={(decision) => void respondPracticeSharing(decision)}
        onRevoke={() => setConfirmRevoke(true)}
      />

      {!allPlayers && assignments.data?.counts ? <div role="group" aria-label="Practice plan state" className="flex flex-wrap gap-2">{(["active", "upcoming", "ended", "cancelled", "all"] as const).map(state => <Button key={state} className="min-h-11" size="sm" variant={(stateFilter ?? "active") === state ? "primary" : "secondary"} aria-pressed={(stateFilter ?? "active") === state} onClick={() => { setStateFilter(state); setAssignmentPage(1); }}>{state[0].toUpperCase() + state.slice(1)} ({assignments.data?.counts?.[state] ?? 0})</Button>)}</div> : null}

      {allPlayers && students.length > 0 ? <PracticeRoster students={assignableStudents} assignments={visibleAssignments} now={now} truncated={!!assignments.data?.hasMore} onSelect={id => { setStudentId(id); setAssignmentPage(1); setStateFilter(null); }} /> : canManage && students.length === 0 ? (
        <Card>
          <div className="py-9 text-center">
            <ListChecks className="mx-auto h-8 w-8 text-text-dim" aria-hidden />
            <h3 className="mt-3 font-display text-h4 font-extrabold text-text">
              Add a student first
            </h3>
            <p className="mx-auto mt-1 max-w-lg text-body text-text-muted">
              Link their SC2 Tools account in Locker, then come back here to assign
              a build or a recurring game target.
            </p>
          </div>
        </Card>
      ) : canManage && selectedRosterStudent?.userId && selectedSharing?.status !== "accepted" ? null
        : visibleAssignments.length > 0 ? (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            {visibleAssignments.map((assignment) => (
              <AssignmentCard
                key={assignment.id}
                assignment={assignment}
                canManage={canManage}
                onCancel={() => setCancelTarget(assignment)}
                onAssignAgain={() => openAgain(assignment)}
                now={now}
              />
            ))}
          </div>
          {assignmentPage > 1 || assignments.data?.hasMore ? (
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={assignmentPage <= 1}
                onClick={() => setAssignmentPage((value) => Math.max(1, value - 1))}
              >
                Newer plans
              </Button>
              <span className="text-micro font-bold uppercase tracking-wider text-text-dim">
                Page {assignments.data?.page || assignmentPage}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={!assignments.data?.hasMore}
                onClick={() => setAssignmentPage((value) => value + 1)}
              >
                Older plans
              </Button>
            </div>
          ) : null}
        </>
      ) : assignmentPage > 1 ? (
        <Card>
          <div className="py-9 text-center">
            <ListChecks className="mx-auto h-8 w-8 text-text-dim" aria-hidden />
            <h3 className="mt-3 font-display text-h4 font-extrabold text-text">
              No older plans on this page
            </h3>
            <Button
              className="mt-4"
              variant="secondary"
              size="sm"
              onClick={() => setAssignmentPage((value) => Math.max(1, value - 1))}
            >
              Back to newer plans
            </Button>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="py-10 text-center">
            <CircleDot className="mx-auto h-8 w-8 text-accent-cyan" aria-hidden />
            <h3 className="mt-3 font-display text-h4 font-extrabold text-text">
              {canManage ? "No practice plan assigned" : "Nothing assigned yet"}
            </h3>
            <p className="mx-auto mt-1 max-w-lg text-body text-text-muted">
              {canManage
                ? "Set a one-time build target or a daily, weekly, or monthly game goal."
                : "When your coach sets a target, every eligible synced 1v1 will count here automatically."}
            </p>
            {canManage ? (
              <Button
                className="mt-5"
                iconLeft={<Plus className="h-4 w-4" />}
                onClick={openCreate}
                disabled={!canAssignSelected}
                title={assignmentDisabledReason || undefined}
              >
                Assign games
              </Button>
            ) : null}
          </div>
        </Card>
      )}

      {draft ? <AssignmentModal
        key={draft.clientRequestId}
        browserTimeZone={timeZone}
        saving={saving}
        draft={draft}
        students={assignableStudents}
        buildSuggestions={buildSuggestions}
        onChange={setDraft}
        onClose={closeAssignmentModal}
        onSave={() => void saveAssignment()}
      /> : null}
      <ConfirmDialog
        open={Boolean(cancelTarget)}
        onClose={closeCancelDialog}
        onConfirm={() => void cancelAssignment()}
        title="Cancel this practice plan?"
        description="Its progress and replay list stay visible, but new games will no longer be expected."
        confirmLabel="Cancel plan"
        intent="danger"
        loading={cancelling}
      />
      <ConfirmDialog
        open={confirmRevoke}
        onClose={closeRevokeDialog}
        onConfirm={() => void revokePracticeSharing()}
        title="Revoke practice replay access?"
        description="Your coach will immediately lose access to assignment evidence and archived original replays. Approving again later will start a new sharing period; old plans stay private."
        confirmLabel="Revoke access"
        intent="danger"
        loading={sharingBusy}
      />
    </div>
  );
}

function PracticeSkeleton() {
  return (
    <div className="space-y-5" aria-label="Loading practice plans">
      <div className="h-40 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="h-80 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
        <div className="h-80 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
      </div>
    </div>
  );
}
