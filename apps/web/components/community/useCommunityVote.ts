"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";

export type CommunityVote = -1 | 0 | 1;
interface VoteState { votes: number; myVote: CommunityVote }

export function communityVoteError(error: unknown): string {
  const status = error && typeof error === "object" && "status" in error ? error.status : 0;
  if (status === 429) return "You're voting too fast. Try again in a minute.";
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 404) return "This build was removed.";
  return "Couldn't save your vote. Try again.";
}

/** One account's toggleable vote, corrected by each authoritative API answer. */
export function useCommunityVote(slug: string, initialVotes: number) {
  const { getToken, isSignedIn, userId } = useAuth();
  const path = `/v1/community/builds/${encodeURIComponent(slug)}`;
  const query = useApi<VoteState>(isSignedIn ? `${path}/my-vote` : null);
  const [state, setState] = useState<VoteState>({ votes: initialVotes, myVote: 0 });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const current = useRef(state);
  current.current = state;
  const scope = `${slug}:${userId ?? ""}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  useEffect(() => {
    setState({ votes: initialVotes, myVote: 0 }); setError(null); setPending(false); inFlight.current = false;
  }, [scope, initialVotes]);
  useEffect(() => {
    if (query.data && !inFlight.current) setState(query.data);
  }, [query.data]);

  async function cast(next: CommunityVote) {
    if (!isSignedIn || inFlight.current || query.isLoading) return;
    const before = current.current;
    const delta = next === before.myVote ? 0 : next;
    inFlight.current = true; setPending(true); setError(null);
    setState({ votes: before.votes - before.myVote + delta, myVote: delta });
    try {
      const answer = await apiCall<VoteState>(getToken, `${path}/vote`, { method: "POST", body: JSON.stringify({ delta }) });
      if (activeScope.current !== scope) return;
      setState(answer); await query.mutate(answer, { revalidate: false });
    } catch (cause) {
      if (activeScope.current !== scope) return;
      setState(before); setError(communityVoteError(cause));
    } finally {
      if (activeScope.current === scope) { inFlight.current = false; setPending(false); }
    }
  }
  return { ...state, cast, pending: pending || Boolean(isSignedIn && query.isLoading), error: error ?? (query.error ? communityVoteError(query.error) : null) };
}
