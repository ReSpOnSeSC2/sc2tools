"use strict";

const { buildNotificationsRouter } = require("./notifications");
const { buildPushRouter } = require("./push");
const { buildReportsRouter } = require("./reports");
const { buildDiscordRouter } = require("./discord");

/**
 * The bell and its delivery channels (docs/notifications.md). Every router
 * here applies auth per route, so the two public endpoints (the calendar
 * feed and the service worker's push rotation) can mount with the public
 * bundle, before any auth-eager router.
 *
 * @param {import('express').Express} app
 * @param {string} prefix
 * @param {{notifications: any, pushNotifications: any, calendarFeed: any, weeklyReports: any, streamReports: any, discordWebhooks: any}} services
 * @param {import('express').RequestHandler} auth
 */
function mountNotificationRoutes(app, prefix, services, auth) {
  app.use(prefix, buildNotificationsRouter({ notifications: services.notifications, auth }));
  app.use(prefix, buildPushRouter({ push: services.pushNotifications, calendar: services.calendarFeed, auth }));
  app.use(prefix, buildReportsRouter({ weekly: services.weeklyReports, streams: services.streamReports, auth }));
  app.use(prefix, buildDiscordRouter({ discord: services.discordWebhooks, auth }));
}

module.exports = { mountNotificationRoutes };
