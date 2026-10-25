"use client";

import { useEffect, useRef, useState } from "react";
import { apiCall, useApi } from "@/lib/clientApi";
import { usePendingIntentResume, type IntentResumeContext } from "@/lib/usePendingIntentResume";
import { useCommunityAction } from "./useCommunityAction";

export type CommunityVote = -1 | 0 | 1;
interface VoteState { votes: number; myVote: CommunityVote; authIntentCompleted?: boolean }
const validVote = (value: VoteState | undefined): value is VoteState => !!value && Number.isFinite(value.votes) && [-1, 0, 1].includes(value.myVote);

export function communityVoteError(error: unknown): string {
  const status = error && typeof error === "object" && "status" in error ? error.status : 0;
  if (status === 429) return "You're voting too fast. Try again in a minute.";
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 404) return "This build was removed.";
  return "Couldn't save your vote. Try again.";
}

/** One account's toggleable vote. A resumed intent sets its exact desired vote;
 * it never toggles an already-correct vote off. Both layouts share the answer. */
export function useCommunityVote(slug: string, initialVotes: number) {
  const action = useCommunityAction(slug), path = `/v1/community/builds/${encodeURIComponent(slug)}`;
  const returnTo = `/community/builds/${encodeURIComponent(slug)}`;
  const query = useApi<VoteState>(action.owner ? `${path}/my-vote` : null, undefined, { timeoutMs: 20_000 });
  const initial = { votes: initialVotes, myVote: 0 as CommunityVote };
  const [state, setState] = useState({ scope: action.scope, value: initial });
  const [error, setError] = useState<{ scope: string; value: string | null }>({ scope: action.scope, value: null });
  const value: VoteState = state.scope === action.scope ? state.value : initial;
  const current = useRef(value); current.current = value;
  const ready = !!action.owner && validVote(query.data) && !query.isLoading && !query.isPreviousData && !query.error;
  const readError = (query.error || query.data && !validVote(query.data)) ? communityVoteError(query.error) : null;
  useEffect(() => {
    if (!action.owner) setState({ scope: action.scope, value: { votes: initialVotes, myVote: 0 } });
  }, [action.owner, action.scope, initialVotes]);
  useEffect(() => {
    if (ready && validVote(query.data) && !action.running) setState({ scope: action.scope, value: query.data });
  }, [ready, query.data, action.scope, action.running]);

  async function writeVote(next: CommunityVote, toggle: boolean, supplied?: IntentResumeContext) {
    if (!ready) return false;
    const before = validVote(query.data) ? query.data : current.current, delta = toggle && next === before.myVote ? 0 : next;
    return action.run(async context => {
      setError({ scope: action.scope, value: null });
      let answer = before;
      if (!supplied || before.myVote !== delta) {
        setState({ scope: action.scope, value: { votes: before.votes - before.myVote + delta, myVote: delta } });
        answer = await apiCall<VoteState>(context.getToken, `${path}/vote`, { method: "POST", signal: context.signal, body: JSON.stringify({ delta }) });
        if (!validVote(answer)) throw new Error("Invalid vote response");
      }
      if (!context.isCurrent()) return false;
      const published = { ...answer, ...(supplied ? { authIntentCompleted: true } : {}) };
      setState({ scope: action.scope, value: published });
      await query.mutate(published, { revalidate: false });
      return context.isCurrent();
    }, cause => { setState({ scope: action.scope, value: before }); setError({ scope: action.scope, value: communityVoteError(cause) }); }, supplied);
  }
  const resume = usePendingIntentResume("vote", returnTo, ready, payload => payload.slug === slug,
    (intent, context) => writeVote(intent.payload.delta, false, context));
  return { ...value, authenticated: !!action.owner, authLoading: action.authLoading,
    cast: async (next: CommunityVote) => { if (!resume.running) await writeVote(next, true).catch(() => {}); },
    completed: resume.completed || !!value.authIntentCompleted,
    pending: action.running || resume.running || Boolean(action.owner && !ready),
    retry: readError ? () => { void query.mutate().catch(() => {}); } : null,
    error: (error.scope === action.scope ? error.value : null) ?? resume.error ?? readError };
}
