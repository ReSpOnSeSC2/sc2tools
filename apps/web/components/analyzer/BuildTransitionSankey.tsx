"use client";

/**
 * BuildTransitionSankey — kept as a re-export shim so existing imports
 * (BuildDossier, ProfileView, tests, etc.) keep working. The actual
 * implementation moved to `./build-flow/BuildTransitionFlow.tsx`,
 * which replaces the unreadable Nivo Sankey with a clean per-path
 * card list. The component name stays for backwards compatibility.
 */

export { BuildTransitionFlow as BuildTransitionSankey } from "./build-flow/BuildTransitionFlow";
export type {
  BuildTransitionFlowProps as BuildTransitionSankeyProps,
  BuildTransitionsPayload,
  MatchupFilter,
  TransitionEdge,
  TransitionNode,
  TransitionNodeId,
  TransitionNodeKind,
} from "./build-flow/types";
