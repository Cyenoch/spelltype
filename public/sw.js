/**
 * SPELLTYPE's game-event service worker.
 *
 * It exists for exactly one job: when a player taps a match reminder, bring back
 * the right window. It intercepts no requests, caches nothing, subscribes to no
 * push service and never syncs in the background — delivery is decided by the
 * visible page, and the app's version story lives in the document, not here.
 */

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(focusReminderTarget(event.notification.data));
});

/**
 * Focus a window already sitting in the reminder's room (including pages the SW
 * does not yet control, e.g. the very page that first registered it); otherwise
 * open a new window at the invite URL. A live match is never navigated away, and
 * anything expired, malformed or forged collapses to the origin root, where the
 * app's own loaders decide what the player actually enters.
 *
 * @param {unknown} data
 */
async function focusReminderTarget(data) {
  const reminder = typeof data === 'object' && data !== null ? data : {};
  const roomId = typeof reminder.roomId === 'string' ? reminder.roomId : '';
  const expiresAt = Number(reminder.expiresAt);
  const valid =
    /^[0-9a-f]{24}$/.test(roomId) && Number.isFinite(expiresAt) && expiresAt > Date.now();
  const target = new URL(valid ? `/?room=${roomId}` : '/', self.location.origin);
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (valid) {
    for (const client of windows) {
      const url = new URL(client.url, self.location.origin);
      if (url.origin === self.location.origin && url.searchParams.get('room') === roomId) {
        try {
          await client.focus();
          return;
        } catch {
          break;
        }
      }
    }
  }
  await self.clients.openWindow(target.href);
}
