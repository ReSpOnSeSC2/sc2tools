"use client";

/* eslint-disable max-lines -- the assignment workflow and evidence card share one state boundary */

import { useAuth } from "@clerk/nextjs";
import {
  CalendarDays,
  CheckCircle2,
  CircleDot,
  Gamepad2,
  ListChecks,
  Plus,
  ShieldCheck,
  Target,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReplayDownloadButton } from "@/components/analyzer/ReplayDownloadButton";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { apiCall, useApi } from "@/lib/clientApi";
import { useUserSocket } from "@/lib/useUserSocket";
import {
  apiMessage,
  fieldClass,
  timeZoneOptions,
  useLocalTimeZone,
} from "./coachingTime";
import {
  addDays,
  buildId,
  buildSuggestionKey,
  cadenceNoun,
  calendarPeriodCount,
  defaultCalendarRange,
  formatGameDate,
  formatWindow,
  localDateKey,
  progressStateLabel,
  requestId,
  requirementDetail,
  requirementTitle,
  statePill,
  type AssignmentDraft,
  type AssignmentGamesPayload,
  type AssignmentsPayload,
  type BuildSuggestion,
  type CoachingRole,
  type LockerStatePayload,
  type PracticeAssignment,
  type PracticeSharingPayload,
  type PracticeSharingRelationship,
  type SlimGame,
  type Student,
} from "./coachingPracticeModel";

export default function CoachingPractice({ role }: { role: CoachingRole }) {
  const canManage = role === "admin" || role === "coach";
  const timeZone = useLocalTimeZone();
  const roster = useApi<LockerStatePayload>(canManage ? "/v1/coaching/state" : null);
  const sharing = useApi<PracticeSharingPayload>("/v1/coaching/practice-sharing", {
    revalidateOnFocus: true,
    refreshInterval: 30_000,
  });
  const [studentId, setStudentId] = useState("");
  const [assignmentPage, setAssignmentPage] = useState(1);
  const selectedSharing = sharing.data?.relationships.find(
    (relationship) => relationship.student.id === studentId,
  ) || null;
  const practiceRelationship = canManage
    ? selectedSharing
    : sharing.data?.relationships[0] || null;
  const assignmentsPath = canManage
    ? (studentId && selectedSharing?.status === "accepted"
      ? `/v1/coaching/assignments?studentId=${encodeURIComponent(studentId)}&page=${assignmentPage}&limit=20`
      : null)
    : `/v1/coaching/assignments?page=${assignmentPage}&limit=20`;
  const assignments = useApi<AssignmentsPayload>(assignmentsPath, {
    revalidateOnFocus: true,
    refreshInterval: 30_000,
  });
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
  const { getToken } = useAuth();
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
    selectedRosterStudent?.userId && selectedSharing?.status === "accepted",
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
    if (studentId && students.some((student) => student.id === studentId)) return;
    if (students[0]) setStudentId(students[0].id);
  }, [studentId, students]);

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
      await sharing.mutate();
      toast.success("Practice sharing request sent", {
        description: `${selectedRosterStudent.name} can review it in Coaching.`,
      });
    } catch (error) {
      await sharing.mutate();
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
      await Promise.all([sharing.mutate(), assignments.mutate()]);
      toast.success(decision === "accepted" ? "Practice sharing enabled" : "Request declined");
    } catch (error) {
      await sharing.mutate();
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
      setConfirmRevoke(false);
      await Promise.all([sharing.mutate(), assignments.mutate()]);
      toast.success("Practice sharing revoked", {
        description: "Your coach can no longer open assignment evidence or replays.",
      });
    } catch (error) {
      setConfirmRevoke(false);
      await sharing.mutate();
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
    for (const assignment of assignments.data?.assignments || []) {
      if (assignment.student.id !== suggestionStudentId) continue;
      const build = assignment.requirement.build;
      add(build?.name, build?.id, build?.matchBy === "slug" ? "slug" : "name");
    }
    return Array.from(byIdentity.values())
      .sort((a, b) => a.name.localeCompare(b.name) || a.matchBy.localeCompare(b.matchBy))
      .slice(0, 100);
  }, [assignments.data, observedGames.data, suggestionStudentId]);

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
    const today = localDateKey(new Date(), timeZone);
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
      timeZone: "",
      title: "",
      note: "",
      clientRequestId: requestId(),
    });
  };

  const saveAssignment = async () => {
    if (!draft) return;
    const requiredGames = Number(draft.requiredGames);
    if (!draft.studentId) {
      toast.error("Choose a student.");
      return;
    }
    if (!assignableStudents.some((student) => student.id === draft.studentId)) {
      toast.error("That student must link their account and approve practice sharing first.");
      return;
    }
    if (!Number.isInteger(requiredGames) || requiredGames < 1 || requiredGames > 1000) {
      toast.error("Required games must be between 1 and 1,000.");
      return;
    }
    if (draft.type === "build" && !draft.buildName.trim()) {
      toast.error("Choose or enter the build the player should use.");
      return;
    }
    const selectedBuild = draft.type === "build" && draft.buildSelection !== "manual"
      ? buildSuggestions.find((item) => buildSuggestionKey(item) === draft.buildSelection)
      : undefined;
    if (draft.type === "build" && draft.buildSelection !== "manual" && !selectedBuild) {
      toast.error("Choose a build available for this student.");
      return;
    }
    if (!draft.startsOn || !draft.endsOn || draft.endsOn < draft.startsOn) {
      toast.error("Choose a valid start and end date.");
      return;
    }
    if (!draft.timeZone) {
      toast.error("Choose the player's time zone.");
      return;
    }
    if (Date.parse(`${draft.endsOn}T00:00:00Z`) - Date.parse(`${draft.startsOn}T00:00:00Z`) > 365 * 86_400_000) {
      toast.error("Practice plans can span up to 366 days.");
      return;
    }

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
      setDraft(null);
      setStudentId(draft.studentId);
      setAssignmentPage(1);
      await assignments.mutate();
      toast.success("Practice plan assigned", {
        description: "Eligible 1v1 games and archived replays will appear automatically.",
      });
    } catch (error) {
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
      setCancelTarget(null);
      await assignments.mutate();
      toast.success("Practice plan cancelled");
    } catch (error) {
      await assignments.mutate();
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
          <label className="flex items-center gap-2 text-caption font-bold text-text-muted">
            Player
            <select
              className={fieldClass("min-w-52 bg-bg-surface")}
              value={studentId}
              onChange={(event) => {
                setStudentId(event.target.value);
                setAssignmentPage(1);
              }}
              aria-label="Practice plan player"
            >
              {students.map((student) => (
                <option key={student.id} value={student.id}>{student.name}</option>
              ))}
            </select>
          </label>
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

      {canManage && students.length === 0 ? (
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

      <AssignmentModal
        open={Boolean(draft)}
        saving={saving}
        draft={draft}
        students={assignableStudents}
        buildSuggestions={buildSuggestions}
        onChange={setDraft}
        onClose={closeAssignmentModal}
        onSave={() => void saveAssignment()}
      />
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

function PracticeSharingPanel({
  canManage,
  relationship,
  selectedStudent,
  busy,
  onRequest,
  onRespond,
  onRevoke,
}: {
  canManage: boolean;
  relationship: PracticeSharingRelationship | null;
  selectedStudent: Student | null;
  busy: boolean;
  onRequest: () => void;
  onRespond: (decision: "accepted" | "rejected") => void;
  onRevoke: () => void;
}) {
  if (canManage) {
    if (!selectedStudent?.userId) return null;
    const accepted = relationship?.status === "accepted";
    const waiting = relationship?.status === "pending" && Boolean(relationship.requestedAt);
    return (
      <Card className={accepted ? "border-success/35 bg-success/5" : "border-accent/30 bg-accent/5"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {accepted ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
            ) : (
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent-cyan" aria-hidden />
            )}
            <div>
              <p className="font-display text-caption font-extrabold text-text">
                {accepted
                  ? `${selectedStudent.name} approved practice sharing`
                  : waiting
                    ? `Waiting for ${selectedStudent.name}`
                    : `${selectedStudent.name}'s approval is required`}
              </p>
              <p className="mt-0.5 text-caption text-text-muted">
                {accepted
                  ? "You can assign plans, review qualifying 1v1 details, and download their archived original replays."
                  : waiting
                    ? "They can accept or decline the request from their Coaching page."
                    : "Send a clear, revocable request before assigning games or opening replay evidence."}
              </p>
            </div>
          </div>
          {!accepted ? (
            <Button
              size="sm"
              variant={waiting ? "secondary" : "primary"}
              onClick={onRequest}
              loading={busy}
              disabled={waiting}
            >
              {waiting ? "Request sent" : "Request approval"}
            </Button>
          ) : null}
        </div>
      </Card>
    );
  }

  if (!relationship) return null;
  if (relationship.status === "pending") {
    return (
      <Card variant="feature" className="border-accent/40">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-accent-cyan" aria-hidden />
            <div>
              <p className="font-display text-h4 font-extrabold text-text">
                Review practice sharing with {relationship.coach.name}
              </p>
              <p className="mt-1 max-w-2xl text-caption text-text-muted">
                Allowing access lets your coach assign targets, see each qualifying future
                ladder or custom 1v1 game’s map, opponent, result, and detected build,
                and download its archived original replay. You can revoke access anytime.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => onRespond("rejected")}>
              Not now
            </Button>
            <Button loading={busy} onClick={() => onRespond("accepted")}>
              Allow sharing
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  if (relationship.status === "accepted") {
    return (
      <Card className="border-success/35 bg-success/5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
            <div>
              <p className="font-display text-caption font-extrabold text-text">Practice sharing is on</p>
              <p className="mt-0.5 text-caption text-text-muted">
                {relationship.coach.name} can review qualifying assignment evidence and archived replays.
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRevoke}>
            Revoke access
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="border-border bg-bg-elevated/30">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-text-dim" aria-hidden />
        <div>
          <p className="font-display text-caption font-extrabold text-text">Practice sharing is off</p>
          <p className="mt-0.5 text-caption text-text-muted">
            {relationship.coach.name} cannot open assignment evidence or archived replays.
            They can send you a new request if you want to enable it later.
          </p>
        </div>
      </div>
    </Card>
  );
}

function AssignmentModal({
  open,
  saving,
  draft,
  students,
  buildSuggestions,
  onChange,
  onClose,
  onSave,
}: {
  open: boolean;
  saving: boolean;
  draft: AssignmentDraft | null;
  students: Student[];
  buildSuggestions: BuildSuggestion[];
  onChange: (draft: AssignmentDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  if (!draft) return null;
  const patch = (next: Partial<AssignmentDraft>) => onChange({ ...draft, ...next });
  const defaultRangeIn = (
    playerTimeZone: string,
    type: AssignmentDraft["type"] = draft.type,
    recurrence: AssignmentDraft["recurrence"] = draft.recurrence,
  ) => {
    const today = localDateKey(new Date(), playerTimeZone);
    return type === "total"
      ? defaultCalendarRange(today, recurrence)
      : { startsOn: today, endsOn: addDays(today, 6) };
  };
  const periodCount = draft.type === "total"
    ? calendarPeriodCount(draft.startsOn, draft.endsOn, draft.recurrence)
    : 1;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Assign a practice plan"
      description="Progress is calculated from the player's synced replay record, never self-reported."
      size="lg"
      disableScrimClose={saving}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={onSave} loading={saving}>Assign plan</Button>
        </>
      )}
    >
      <div className="space-y-5">
        <label className="block text-caption font-bold text-text-muted">
          Student
          <select
            className={fieldClass("mt-2 w-full")}
            value={draft.studentId}
            onChange={(event) => patch({
              studentId: event.target.value,
              buildSelection: "manual",
              buildName: "",
            })}
          >
            {students.map((student) => (
              <option key={student.id} value={student.id}>{student.name}</option>
            ))}
          </select>
        </label>

        <fieldset>
          <legend className="text-caption font-bold text-text-muted">What should count?</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <ChoiceButton
              active={draft.type === "build"}
              icon={<Target className="h-4 w-4" />}
              title="A specific build"
              detail="One target inside a selected date window"
              onClick={() => patch({ type: "build" })}
            />
            <ChoiceButton
              active={draft.type === "total"}
              icon={<Gamepad2 className="h-4 w-4" />}
              title="Total 1v1 games"
              detail="A repeating daily, weekly, or monthly target"
              onClick={() => patch({
                type: "total",
                recurrence: "weekly",
                ...(!draft.totalRangeInitialized && !draft.dateRangeEdited
                  ? defaultCalendarRange(draft.startsOn, "weekly")
                  : {}),
                totalRangeInitialized: true,
              })}
            />
          </div>
        </fieldset>

        {draft.type === "build" ? (
          <div className="space-y-3">
            <label className="block text-caption font-bold text-text-muted">
              Build
              <select
                className={fieldClass("mt-2 w-full")}
                value={draft.buildSelection}
                onChange={(event) => {
                  const buildSelection = event.target.value;
                  const selected = buildSuggestions.find(
                    (item) => buildSuggestionKey(item) === buildSelection,
                  );
                  patch({ buildSelection, buildName: selected?.name || "" });
                }}
              >
                <option value="manual">Enter an exact detected style name…</option>
                {buildSuggestions.map((item) => (
                  <option key={buildSuggestionKey(item)} value={buildSuggestionKey(item)}>
                    {item.name} — {item.matchBy === "slug" ? "custom build" : "detected style"}
                  </option>
                ))}
              </select>
            </label>
            {draft.buildSelection === "manual" ? (
              <label className="block text-caption font-bold text-text-muted">
                Exact detected style name
                <input
                  className={fieldClass("mt-2 w-full")}
                  value={draft.buildName}
                  onChange={(event) => patch({ buildName: event.target.value })}
                  placeholder="e.g. PvP - Phoenix Style"
                  autoComplete="off"
                />
              </label>
            ) : (
              <p className="text-caption text-text-dim">
                {buildSuggestions.find((item) => buildSuggestionKey(item) === draft.buildSelection)?.matchBy === "slug"
                  ? "Matches this exact custom-build identity, even when another build has the same display name."
                  : "Matches this exact replay-engine style name."}
              </p>
            )}
          </div>
        ) : (
          <label className="block text-caption font-bold text-text-muted">
            Repeat target
            <select
              className={fieldClass("mt-2 w-full")}
              value={draft.recurrence}
              onChange={(event) => {
                const recurrence = event.target.value as AssignmentDraft["recurrence"];
                patch({ recurrence });
              }}
            >
              <option value="daily">Per day</option>
              <option value="weekly">Per week</option>
              <option value="monthly">Per month</option>
            </select>
          </label>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-caption font-bold text-text-muted">
            Required games
            <input
              className={fieldClass("mt-2 w-full tabular-nums")}
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              value={draft.requiredGames}
              onChange={(event) => patch({ requiredGames: event.target.value })}
            />
          </label>
          <label className="block text-caption font-bold text-text-muted">
            Starts
            <input
              className={fieldClass("mt-2 w-full")}
              type="date"
              value={draft.startsOn}
              onChange={(event) => patch({
                startsOn: event.target.value,
                dateRangeEdited: true,
              })}
            />
          </label>
          <label className="block text-caption font-bold text-text-muted">
            Ends
            <input
              className={fieldClass("mt-2 w-full")}
              type="date"
              min={draft.startsOn}
              value={draft.endsOn}
              onChange={(event) => patch({
                endsOn: event.target.value,
                dateRangeEdited: true,
              })}
            />
          </label>
        </div>

        <label className="block text-caption font-bold text-text-muted">
          Player&apos;s time zone
          <select
            className={fieldClass("mt-2 w-full")}
            value={draft.timeZone}
            onChange={(event) => {
              const nextTimeZone = event.target.value;
              patch({
                timeZone: nextTimeZone,
                ...(!draft.dateRangeEdited
                  ? defaultRangeIn(nextTimeZone)
                  : {}),
              });
            }}
            aria-label="Player's time zone"
            required
          >
            <option value="" disabled>Select the player&apos;s time zone…</option>
            {timeZoneOptions(draft.timeZone).filter(Boolean).map((zone) => (
              <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>
            ))}
          </select>
          <span className="mt-1 block font-normal text-micro text-text-dim">
            Daily, weekly, and monthly boundaries follow the player&apos;s local calendar.
          </span>
        </label>

        <div className="rounded-xl border border-border bg-bg-elevated/45 px-4 py-3 text-caption text-text-muted">
          <span className="font-bold text-text">
            {draft.type === "build"
              ? "Counts one target across the selected window"
              : `Creates ${periodCount} calendar ${cadenceNoun(draft.recurrence)} target${periodCount === 1 ? "" : "s"}`}
          </span>
          <span>
            {draft.timeZone
              ? ` · Boundaries use ${draft.timeZone.replaceAll("_", " ")}.`
              : " · Choose the player's time zone before assigning."}
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-caption font-bold text-text-muted">
            Plan title <span className="font-normal text-text-dim">(optional)</span>
            <input
              className={fieldClass("mt-2 w-full")}
              value={draft.title}
              maxLength={120}
              onChange={(event) => patch({ title: event.target.value })}
              placeholder="e.g. PvP Phoenix reps"
            />
          </label>
          <label className="block text-caption font-bold text-text-muted">
            Note <span className="font-normal text-text-dim">(optional)</span>
            <input
              className={fieldClass("mt-2 w-full")}
              value={draft.note}
              maxLength={500}
              onChange={(event) => patch({ note: event.target.value })}
              placeholder="One cue to focus on"
            />
          </label>
        </div>
      </div>
    </Modal>
  );
}

function ChoiceButton({
  active,
  icon,
  title,
  detail,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        "flex min-h-20 items-start gap-3 rounded-xl border-2 p-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active
          ? "border-accent bg-accent/10"
          : "border-line bg-bg hover:bg-bg-elevated",
      ].join(" ")}
    >
      <span className={active ? "mt-0.5 text-accent-cyan" : "mt-0.5 text-text-dim"} aria-hidden>
        {icon}
      </span>
      <span>
        <span className="block font-display text-caption font-extrabold text-text">{title}</span>
        <span className="mt-0.5 block text-micro text-text-muted">{detail}</span>
      </span>
    </button>
  );
}

function AssignmentCard({
  assignment,
  canManage,
  onCancel,
}: {
  assignment: PracticeAssignment;
  canManage: boolean;
  onCancel: () => void;
}) {
  const progress = assignment.progress;
  const bucket = progress.currentBucket
    || (progress.state === "met" || progress.state === "missed"
      ? progress.buckets.at(-1)
      : progress.buckets[0])
    || null;
  const played = bucket?.playedGames ?? progress.playedGames;
  const required = bucket?.requiredGames
    ?? (progress.requiredGamesTotal || assignment.requirement.requiredGames);
  const percentage = required > 0 ? Math.min(100, (played / required) * 100) : 0;
  const recurring = assignment.requirement.recurrence !== "once";
  const title = assignment.requirement.title?.trim() || requirementTitle(assignment);
  const status = progressStateLabel(progress.state);
  const remaining = Math.max(0, required - played);
  const targetCopy = progress.state === "cancelled"
    ? (played > 0 ? `${played} recorded before cancellation` : "No games counted")
    : remaining === 0
      ? "Target reached"
      : `${remaining} to go`;
  const cancellable = assignment.status === "active"
    && (progress.state === "active" || progress.state === "upcoming");

  return (
    <Card className="flex min-h-full flex-col" padded={false}>
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={statePill(progress.state)}>{status}</span>
              {canManage ? (
                <span className="text-micro font-bold uppercase tracking-wider text-text-dim">
                  {assignment.student.name}
                </span>
              ) : null}
            </div>
            <h3 className="mt-2 font-display text-h4 font-extrabold text-text">{title}</h3>
            <p className="mt-1 text-caption text-text-muted">{requirementDetail(assignment)}</p>
          </div>
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-bg-elevated text-accent-cyan">
            {assignment.requirement.type === "build"
              ? <Target className="h-5 w-5" aria-hidden />
              : <Gamepad2 className="h-5 w-5" aria-hidden />}
          </span>
        </div>

        <div className="mt-5 rounded-xl border border-border bg-bg-elevated/45 p-4">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-micro font-bold uppercase tracking-wider text-text-dim">
                {recurring ? `This ${cadenceNoun(assignment.requirement.recurrence)}` : "Progress"}
              </p>
              <p className="mt-1 font-display text-h3 font-extrabold tabular-nums text-text">
                {played}<span className="text-body text-text-muted"> / {required}</span>
              </p>
            </div>
            <p className="text-right text-caption font-bold text-text-muted">
              {targetCopy}
            </p>
          </div>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-bg-subtle"
            role="progressbar"
            aria-label={`${title}${canManage ? ` for ${assignment.student.name}` : ""}: ${played} of ${required} games`}
            aria-valuemin={0}
            aria-valuemax={required}
            aria-valuenow={Math.min(played, required)}
          >
            <div
              className={[
                "h-full rounded-full transition-[width]",
                played >= required ? "bg-success" : "bg-accent-cyan",
              ].join(" ")}
              style={{ width: `${percentage}%` }}
            />
          </div>
          {recurring ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-micro text-text-dim">
              <span>{progress.completedBuckets} of {progress.totalBuckets} periods complete</span>
              {bucket ? <span>{formatWindow(bucket.startsAt, bucket.endsAt, assignment.requirement.timeZone)}</span> : null}
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex items-start gap-2 text-caption text-text-muted">
          <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-text-dim" aria-hidden />
          <span>{formatWindow(assignment.requirement.window.startsAt, assignment.requirement.window.endsAt, assignment.requirement.timeZone)}</span>
        </div>
        {assignment.requirement.note ? <p className="mt-3 text-caption text-text-muted">{assignment.requirement.note}</p> : null}

        <ReplayEvidence assignment={assignment} />
      </div>
      {canManage && cancellable ? (
        <div className="flex justify-end border-t border-border bg-bg-elevated/30 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onCancel} iconLeft={<XCircle className="h-4 w-4" />}>
            Cancel plan
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function ReplayEvidence({ assignment }: { assignment: PracticeAssignment }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const evidence = useApi<AssignmentGamesPayload>(
    open
      ? `/v1/coaching/assignments/${encodeURIComponent(assignment.id)}/games?page=${page}&limit=25`
      : null,
    {
      revalidateOnFocus: true,
      refreshInterval: open ? 30_000 : 0,
    },
  );
  const games = evidence.data?.games || [];
  const total = evidence.data?.total ?? assignment.progress.replayGameCount
    ?? assignment.progress.playedGames;
  const totalPages = Math.max(1, Math.ceil(total / (evidence.data?.limit || 25)));
  const assignmentLabel = assignment.requirement.title?.trim() || requirementTitle(assignment);
  return (
    <details
      className="group mt-4 border-t border-border pt-4"
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (!nextOpen) setPage(1);
      }}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg py-1 text-caption font-bold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <span className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-accent-cyan" aria-hidden />
          Games and replay evidence
        </span>
        <span className="rounded-full border border-border bg-bg-elevated px-2.5 py-0.5 font-mono text-micro tabular-nums text-text-muted">
          {total}
        </span>
      </summary>
      <div className="mt-3 space-y-2">
        {evidence.isLoading && !evidence.data ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-caption text-text-dim">
            Loading replay evidence…
          </div>
        ) : evidence.error ? (
          <div className="rounded-xl border border-dashed border-danger/40 px-4 py-5 text-center text-caption text-danger">
            Replay evidence could not load. Close and reopen this list to retry.
          </div>
        ) : games.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-caption text-text-dim">
            No eligible 1v1 replays have landed in this timeframe yet.
          </div>
        ) : games.map((game) => (
          <div
            key={game.gameId}
            className="flex items-center gap-3 rounded-xl border border-border bg-bg-elevated/35 px-3 py-2.5"
          >
            <span className={[
              "grid h-8 w-8 shrink-0 place-items-center rounded-lg border font-mono text-micro font-extrabold",
              /victory|win/i.test(game.result)
                ? "border-success/35 bg-success/10 text-success"
                : /defeat|loss/i.test(game.result)
                  ? "border-danger/35 bg-danger/10 text-danger"
                  : "border-border text-text-dim",
            ].join(" ")}>
              {/victory|win/i.test(game.result) ? "W" : /defeat|loss/i.test(game.result) ? "L" : "—"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-caption font-bold text-text">
                {game.map || "Unknown map"}{game.opponent ? ` · vs ${game.opponent}` : ""}
              </p>
              <p className="truncate text-micro text-text-dim">
                {formatGameDate(game.date, assignment.requirement.timeZone)}
                {game.myBuild ? ` · ${game.myBuild}` : ""}
                {game.isLadderGame === true
                  ? " · Ladder 1v1"
                  : game.isLadderGame === false
                    ? " · Custom 1v1"
                    : " · 1v1"}
              </p>
            </div>
            <ReplayDownloadButton
              gameId={game.gameId}
              available={game.replayAvailable}
              showLabel
              contextLabel={`${game.map || "game"} on ${formatGameDate(game.date, assignment.requirement.timeZone)}`}
              downloadPath={`/v1/coaching/assignments/${encodeURIComponent(assignment.id)}/games/${encodeURIComponent(game.gameId)}/replay-download`}
              unavailableMessage="This student replay is not archived yet. Ask the student to update the desktop agent and run Re-sync."
            />
          </div>
        ))}
        {totalPages > 1 ? (
          <div className="flex items-center justify-between gap-3 pt-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1}
              aria-label={`Newer games for ${assignmentLabel}`}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Newer
            </Button>
            <span className="text-micro text-text-dim">Page {page} of {totalPages}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={!evidence.data?.hasMore}
              aria-label={`Older games for ${assignmentLabel}`}
              onClick={() => setPage((value) => value + 1)}
            >
              Older
            </Button>
          </div>
        ) : null}
      </div>
    </details>
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
