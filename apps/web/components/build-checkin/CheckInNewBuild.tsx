"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useApi } from "@/lib/clientApi";
import type { BuildOrderEvent } from "@/lib/build-events";
import type { RaceLite, VsRaceLite } from "@/lib/build-rules";
import type { GameBuildOrderResponse } from "@/components/analyzer/game/types";
import {
  customBuildKey,
  defaultNewBuildName,
  type CheckInSide,
} from "@/lib/buildIntent";

/** What to open the editor for. */
export interface NewBuildRequest {
  gameId: string;
  side: CheckInSide;
  /** The picker's search text; becomes the new build's name. */
  defaultName?: string;
  /** The game's races (check-in state); the replay's are the fallback. */
  myRace?: string | null;
  oppRace?: string | null;
}

/** A build the editor saved, as the check-in confirms it. */
export interface NewBuildSaved {
  gameId: string;
  side: CheckInSide;
  slug: string;
  /** `custom:<slug>` */
  key: string;
  name: string;
}

interface LoadingState {
  open: boolean;
  side: CheckInSide;
  onClose: () => void;
}

// The editor chunk's loading fallback renders inside this tree, so it can
// read the close handler from context and stay a real, closable dialog.
const EditorLoadingContext = createContext<LoadingState | null>(null);

function EditorChunkLoading() {
  const state = useContext(EditorLoadingContext);
  return state?.open ? <NewBuildLoading side={state.side} onClose={state.onClose} /> : null;
}

// The rules editor is large and only needed once a player asks for it;
// the check-in queue lives in the header of every page.
const BuildEditorModal = dynamic(
  () => import("@/components/builds/editor").then((mod) => mod.BuildEditorModal),
  { ssr: false, loading: () => <EditorChunkLoading /> },
);

const NO_EVENTS: ReadonlyArray<BuildOrderEvent> = [];

/**
 * CheckInNewBuild — "Add new build" from a build check-in. Opens the
 * custom-build rules editor (the "Save as new build" editor from the
 * replay pages) on this game's build order for one side: your own
 * events for "you", the opponent's for "opponent". The matchup is locked
 * to the game and the save never overwrites an existing build, so the
 * new build always fits the check-in it was made for.
 *
 * `request` null closes it. The component stays mounted after the first
 * open so the editor's own "Saved" toasts outlive the dialog.
 */
export function CheckInNewBuild({
  request,
  onClose,
  onSaved,
}: {
  request: NewBuildRequest | null;
  onClose: () => void;
  onSaved: (saved: NewBuildSaved) => void;
}) {
  // Keep the last request so the closed editor keeps stable props.
  const [last, setLast] = useState<NewBuildRequest | null>(request);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (request) setLast(request);
  }, [request]);
  const active = request ?? last;

  // Same SWR key as the game page's build-order request, so a launcher on
  // the game page reuses the build order that is already loaded.
  const buildOrder = useApi<GameBuildOrderResponse>(
    active ? `/v1/games/${encodeURIComponent(active.gameId)}/build-order` : null,
    { revalidateOnFocus: false },
  );
  // A game without a parsed build order still opens: the editor's "Add a
  // rule" bar works without a timeline.
  const ready = Boolean(buildOrder.data || buildOrder.error);

  useEffect(() => {
    if (!request) return;
    // Fetch the editor chunk while the build order loads.
    void import("@/components/builds/editor");
  }, [request]);

  useEffect(() => {
    if (request && ready) setMounted(true);
  }, [request, ready]);

  const editorProps = useMemo(() => {
    if (!active) return null;
    const data = buildOrder.data;
    const myRace = active.myRace || data?.my_race || null;
    const oppRace = active.oppRace || data?.opp_race || null;
    const opponentSide = active.side === "opponent";
    return {
      events: (opponentSide ? data?.opp_events : data?.events) ?? NO_EVENTS,
      race: coerceRace(opponentSide ? oppRace : myRace),
      vsRace: coerceVsRace(opponentSide ? myRace : oppRace),
      perspective: active.side,
      defaultName:
        active.defaultName?.trim() || defaultNewBuildName(active.side, myRace, oppRace),
    };
  }, [active, buildOrder.data]);

  const open = Boolean(request) && ready;
  const loadingState = useMemo<LoadingState | null>(
    () => (active ? { open, side: active.side, onClose } : null),
    [active, open, onClose],
  );

  return (
    <>
      {request && !ready ? <NewBuildLoading side={request.side} onClose={onClose} /> : null}
      {(mounted || open) && active && editorProps ? (
        <EditorLoadingContext.Provider value={loadingState}>
          <BuildEditorModal
            open={open}
            onClose={onClose}
            events={editorProps.events}
            gameId={active.gameId}
            race={editorProps.race}
            vsRace={editorProps.vsRace}
            perspective={editorProps.perspective}
            defaultName={editorProps.defaultName}
            mode="create"
            lockMatchup
            createOnly
            onSaved={(slug, draft) =>
              onSaved({
                gameId: active.gameId,
                side: active.side,
                slug,
                key: customBuildKey(slug),
                name: draft.name.trim() || editorProps.defaultName,
              })
            }
          />
        </EditorLoadingContext.Provider>
      ) : null}
    </>
  );
}

function NewBuildLoading({ side, onClose }: { side: CheckInSide; onClose: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={side === "opponent" ? "Add the opponent's build" : "Add a new build"}
      description="Builds made here are saved to your library and checked in for this game."
    >
      <p
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-caption text-text-muted"
      >
        <Loader2 className="h-4 w-4 shrink-0 motion-safe:animate-spin" aria-hidden />
        Loading this game&apos;s build order…
      </p>
    </Modal>
  );
}

/** Race names or letters → the editor's race; unknown is Random. */
function coerceRace(input: string | null | undefined): RaceLite {
  switch ((input || "").trim().charAt(0).toUpperCase()) {
    case "P":
      return "Protoss";
    case "T":
      return "Terran";
    case "Z":
      return "Zerg";
    default:
      return "Random";
  }
}

/** Like `coerceRace`, but an unknown opponent race matches Any. */
function coerceVsRace(input: string | null | undefined): VsRaceLite {
  const race = coerceRace(input);
  return race === "Random" && !/^r/i.test((input || "").trim()) ? "Any" : race;
}
