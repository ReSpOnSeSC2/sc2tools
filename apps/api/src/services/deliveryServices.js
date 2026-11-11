"use strict";

const { NotificationsService } = require("./notifications");
const { PushNotificationsService } = require("./pushNotifications");
const { CalendarFeedService } = require("./calendarFeed");
const { CoachingRemindersService } = require("./coachingReminders");
const { WeeklyReportService } = require("./weeklyReport");
const { StreamReportsService } = require("./streamReports");
const { DiscordWebhooksService } = require("./discordWebhooks");

/**
 * The bell plus everything that delivers through it or beside it
 * (docs/notifications.md): Web Push devices, weekly and stream reports,
 * Discord webhooks, the coaching calendar feed and session reminders.
 *
 * Web Push stays inert until the WEB_PUSH_VAPID_* variables are set;
 * Discord is unavailable (and never sends) without
 * PLATFORM_TOKEN_ENCRYPTION_KEY. The session policy is attached once
 * app.js has built it, because reports and session summaries share the
 * user's session gap.
 *
 * @param {{db: import('../db/connect').DbContext, io?: import('socket.io').Server, logger: import('pino').Logger,
 *   config: {delivery?: {webPush: {publicKey: string, privateKey: string, subject: string}|null, discordEncryptionKey: string|null}}}} deps
 */
function buildNotificationServices(deps) {
  const logger = deps.logger;
  const notifications = new NotificationsService(deps.db, { io: deps.io, logger });
  const pushNotifications = new PushNotificationsService(deps.db, { config: deps.config.delivery?.webPush || null, logger });
  notifications.push = pushNotifications;
  const streamReports = new StreamReportsService(deps.db, { notifications, logger });
  const weeklyReports = new WeeklyReportService(deps.db, { notifications, logger });
  const discordWebhooks = new DiscordWebhooksService(deps.db, { encryptionKey: deps.config.delivery?.discordEncryptionKey || null,
    notifications, weekly: weeklyReports, logger });
  weeklyReports.onWeekly = (userId, report) => discordWebhooks.onWeekly(userId, report);
  return {
    notifications,
    delivery: {
      pushNotifications, streamReports, weeklyReports, discordWebhooks,
      calendarFeed: new CalendarFeedService(deps.db),
      coachingReminders: new CoachingRemindersService(deps.db, { notifications, logger }),
    },
    /** @param {{resolve: (owner: string) => Promise<{gapMinutes: number}>}} policy */
    useSessionPolicy(policy) {
      weeklyReports.sessionPolicy = policy;
      discordWebhooks.sessionPolicy = policy;
    },
  };
}

module.exports = { buildNotificationServices };
