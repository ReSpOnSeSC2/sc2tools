"use client";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
export type AdminActionResult = { userId?: string; games?: number; opponents?: number; macroJobs?: number; droppedRows?: number };
type State = { kind: "idle" } | { kind: "confirm" | "busy"; endpoint: string } | { kind: "done"; result: AdminActionResult } | { kind: "error"; message: string };
export function useAdminAction(onDone?: () => void) {
  const { getToken } = useAuth();
  const [state, setState] = useState<State>({ kind: "idle" });
  const inFlight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run() {
    if (state.kind !== "confirm" || inFlight.current) return;
    inFlight.current = true; setState({ kind: "busy", endpoint: state.endpoint });
    try {
      const result = await apiCall<AdminActionResult>(getToken, state.endpoint, { method: "POST" });
      if (mounted.current) { setState({ kind: "done", result }); onDone?.(); }
    } catch (error) {
      if (mounted.current) setState({ kind: "error", message: (error as ClientApiError)?.code === "user_not_found" ? "No user with that ID" : error instanceof Error ? error.message : "Action failed. Try again." });
    } finally { inFlight.current = false; }
  }
  return { state, begin: (endpoint: string) => { if (!inFlight.current) setState({ kind: "confirm", endpoint }); }, dismiss: () => { if (!inFlight.current) setState({ kind: "idle" }); }, run };
}
