import type {
  FlowRow,
  FlowStep,
  TransitionEdge,
  TransitionNode,
  TransitionNodeId,
  TransitionNodeKind,
} from "./types";

/**
 * Walk the transitions graph and produce one row per distinct path
 * (build → strategy → final phase → composition). Rows are deduplicated
 * on the joined step ids and stats are summed from the edges that
 * appear on each segment.
 *
 * The previous Sankey was edge-centric (each edge = a chart link); the
 * flow visualization is path-centric so a reader can scan one row and
 * understand "when I play X and they go Y, the game ends in phase Z
 * with composition W — and I'm 3–2 in 5 games on that line." Much more
 * readable than a tangle of links.
 */
export function buildRows(
  nodes: TransitionNode[],
  edges: TransitionEdge[],
): FlowRow[] {
  if (edges.length === 0 || nodes.length === 0) return [];

  const nodeById = new Map<TransitionNodeId, TransitionNode>();
  for (const n of nodes) nodeById.set(n.id, n);

  const outgoing = new Map<TransitionNodeId, TransitionEdge[]>();
  for (const e of edges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from)!.push(e);
  }

  const buildNodes = nodes.filter((n) => n.column === 0);
  const rows: FlowRow[] = [];

  for (const root of buildNodes) {
    walk(root, [stepFromNode(root)], root.games, root.wins, root.losses);
  }

  // Aggregate paths that arrived at the same set of steps.
  const merged = new Map<string, FlowRow>();
  for (const row of rows) {
    const existing = merged.get(row.key);
    if (existing) {
      existing.games += row.games;
      existing.wins += row.wins;
      existing.losses += row.losses;
      const denom = existing.wins + existing.losses;
      existing.winRate = denom > 0 ? existing.wins / denom : 0;
    } else {
      merged.set(row.key, { ...row });
    }
  }
  return Array.from(merged.values()).sort((a, b) => b.games - a.games);

  function walk(
    cursor: TransitionNode,
    pathSteps: FlowStep[],
    games: number,
    wins: number,
    losses: number,
  ): void {
    const next = outgoing.get(cursor.id);
    if (!next || next.length === 0) {
      pushRow(pathSteps, games, wins, losses);
      return;
    }
    for (const edge of next) {
      const child = nodeById.get(edge.to);
      if (!child) continue;
      walk(
        child,
        [...pathSteps, stepFromNode(child)],
        edge.games,
        edge.wins,
        edge.losses,
      );
    }
  }

  function pushRow(
    steps: FlowStep[],
    games: number,
    wins: number,
    losses: number,
  ): void {
    if (steps.length === 0) return;
    const denom = wins + losses;
    rows.push({
      key: steps.map((s) => s.nodeId).join("→"),
      steps,
      games,
      wins,
      losses,
      winRate: denom > 0 ? wins / denom : 0,
    });
  }
}

function stepFromNode(n: TransitionNode): FlowStep {
  return {
    nodeId: n.id,
    label: n.label,
    kind: n.kind,
    iconTokens: n.iconTokens,
  };
}

/**
 * Derive the displayed nodes/edges given the active matchup filter.
 * Shared with the legacy Sankey export so test fixtures keep working
 * unchanged.
 */
export function deriveDisplay(
  rawNodes: TransitionNode[],
  rawEdges: TransitionEdge[],
  byMatchup:
    | Record<
        string,
        Array<{
          edgeIdx: number;
          games: number;
          wins: number;
          losses: number;
        }>
      >
    | undefined,
  filter: string,
): { displayNodes: TransitionNode[]; displayEdges: TransitionEdge[] } {
  if (filter === "All" || !byMatchup || !byMatchup[filter]) {
    return { displayNodes: rawNodes, displayEdges: rawEdges };
  }
  const entries = byMatchup[filter];
  const filteredEdges: TransitionEdge[] = [];
  for (const e of entries) {
    if (e.games <= 0) continue;
    const base = rawEdges[e.edgeIdx];
    if (!base) continue;
    const denom = e.wins + e.losses;
    filteredEdges.push({
      from: base.from,
      to: base.to,
      games: e.games,
      wins: e.wins,
      losses: e.losses,
      winRate: denom > 0 ? e.wins / denom : 0,
    });
  }
  const reachable = new Set<TransitionNodeId>();
  for (const e of filteredEdges) {
    reachable.add(e.from);
    reachable.add(e.to);
  }
  for (const n of rawNodes) if (n.column === 0) reachable.add(n.id);
  const filteredNodes = rawNodes.filter((n) => reachable.has(n.id));
  return { displayNodes: filteredNodes, displayEdges: filteredEdges };
}

export const KIND_ORDER: TransitionNodeKind[] = [
  "build",
  "oppStrategy",
  "oppRace",
  "finalPhase",
  "lateComp",
];
