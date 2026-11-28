"use strict";

const { buildLiveStreamsRouter } = require("./liveStreams");
const { buildLadderVodsRouter, ladderVodsFromDeps } = require("./ladderVods");
const { buildProBoardRouter } = require("./proBoard");
const { PulseClient } = require("../services/pulseClient");
const { ProBoardService } = require("../services/proBoard");

/**
 * The pros board, with the one paced SC2Pulse client the ladder VOD finder
 * shares (`proBoard.pulse`), so the two never call SC2Pulse faster together
 * than the pace allows. Both gates are the service's.
 *
 * @param {{ logger: import("pino").Logger }} deps
 * @param {import("../services/liveStreams").LiveStreamsService} liveStreams the live list that links a pro to a channel
 */
function proBoardFromDeps({ logger }, liveStreams) {
  return new ProBoardService({ pulse: new PulseClient(), liveStreams, log: logger });
}

/**
 * Mounts the public live and ladder routes: live streams, the ladder VOD
 * finder and the pros board. Each is gated or cached by its own service.
 *
 * @param {import("express").Express} app
 * @param {string} prefix the API route prefix
 * @param {{ deps: Parameters<typeof ladderVodsFromDeps>[0], services: Record<string, any> }} context
 */
function mountLiveLadderRoutes(app, prefix, { deps, services }) {
  app.use(prefix, buildLiveStreamsRouter({ liveStreams: services.liveStreams }));
  app.use(prefix, buildLadderVodsRouter({ ladderVods: ladderVodsFromDeps(deps, services.seasons?.ladderMapPool, services.proBoard.pulse) }));
  app.use(prefix, buildProBoardRouter({ proBoard: services.proBoard }));
}

module.exports = { mountLiveLadderRoutes, proBoardFromDeps };
