/**
 * Disconnects: the match never freezes, a reconnecting player gets their seat, health and accepted
 * draft back, and the live match — identity, absolute deadline, per-player progress — survives a
 * process restart. (A session dying mid-match is covered by the auth spec.)
 *
 * The harness restarts the native runtime on the same port and database, without a product test
 * hook, so only committed state survives.
 */
import { expect } from '@playwright/test';
import { test } from '../support/test';
import { INITIAL_HEALTH } from '../../shared/protocol';
import { acceptedGeneration, fixture } from '../support/runtime';
import { harness } from '../support/harness';
import {
  battleMatchId,
  battlePhase,
  completeSpell,
  completionDamage,
  deadline,
  inputValue,
  roomSnapshot,
  seatHealth,
  snapshotPlayer,
  spellText,
  timerRemaining,
  typeText,
  waitForCombat,
} from '../support/combat';
import { selfIdentity } from '../support/api';
import { gotoApp, settle } from '../support/app';
import { startMatch, twoPlayerRoom } from '../support/lobby';
import { newContext, signIn } from '../support/session';

test.beforeEach(async () => {
  await fixture().reset();
});

test('对手断线不冻结比赛，重连与进程重启后恢复席位、血量与已接受草稿', async ({ browser }) => {
  test.setTimeout(900_000);
  const room = await twoPlayerRoom(browser, { theme: '断线契约' });
  const host = room.host;
  const guest = room.guest;
  const guestIdentity = await selfIdentity(guest.context);
  const hostIdentity = await selfIdentity(host.context);
  const guestName = guestIdentity.username;
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guest.page)]);

  const book = acceptedGeneration(await fixture().state()).generation.texts;
  const firstSpell = book[0];
  const liveMatchId = await battleMatchId(host.page);
  const combatDeadline = await deadline(host.page);

  // The guest commits a prefix, which the host can see, then drops off the network entirely.
  await typeText(guest.page, firstSpell.slice(0, 5));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(host.context, room.roomId), guestIdentity).progress,
      { timeout: 20_000 },
    )
    .toBe(5);
  await guest.context.close();

  // The remaining player keeps a live, decreasing clock instead of a frozen match.
  const before = await timerRemaining(host.page);
  await settle(2500);
  expect(await timerRemaining(host.page)).toBeLessThan(before - 1000);
  expect(await host.page.getByTestId('arena-seat').count()).toBe(2);
  expect(await battlePhase(host.page)).toBe('playing');

  // The disconnected player keeps their seat, their accepted prefix and their health; only the
  // connection flag changes.
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(host.context, room.roomId), guestIdentity).connected,
      { timeout: 20_000 },
    )
    .toBe(false);
  const during = await roomSnapshot(host.context, room.roomId);
  expect(during.matchId).toBe(liveMatchId);
  expect(snapshotPlayer(during, guestIdentity).progress).toBe(5);
  expect(snapshotPlayer(during, guestIdentity).hp).toBe(INITIAL_HEALTH);

  // The match keeps moving without the opponent: a real completion still lands on the absent
  // target. Damage arrives with the completion's batch window, so the health read polls.
  await completeSpell(host.page);
  await expect
    .poll(
      async () => snapshotPlayer(await roomSnapshot(host.context, room.roomId), guestIdentity).hp,
      { timeout: 30_000 },
    )
    .toBe(INITIAL_HEALTH - completionDamage(firstSpell));
  const damaged = await roomSnapshot(host.context, room.roomId);
  expect(snapshotPlayer(damaged, hostIdentity).spellsCast).toBe(1);

  // Reconnect: same seat, same match, same accepted draft, restored to that player only.
  const firstReconnect = await newContext(browser);
  const firstPage = await firstReconnect.newPage();
  await gotoApp(firstPage, '/');
  await signIn(firstPage, guestName);
  await gotoApp(firstPage, `/?room=${room.roomId}`);
  await waitForCombat(firstPage);
  expect(await battleMatchId(firstPage)).toBe(liveMatchId);
  expect(await deadline(firstPage)).toBe(combatDeadline);
  await expect.poll(() => inputValue(firstPage), { timeout: 30_000 }).toBe(firstSpell.slice(0, 5));
  const restored = await roomSnapshot(firstReconnect, room.roomId);
  expect(restored.selfInput).toBe(firstSpell.slice(0, 5));
  const hostView = await roomSnapshot(host.context, room.roomId);
  expect(hostView.selfInput).not.toBe(restored.selfInput);

  // The draft is a real accepted prefix: completing the rest of it finishes the spell.
  expect(await completeSpell(firstPage)).toBe(firstSpell);
  expect(await battlePhase(host.page)).toBe('playing');

  // Native runtime recovery: both clients disconnect and the runtime restarts against the same
  // database and port. The running match must survive with its identity, its
  // absolute deadline and every player's accepted state.
  const matchIdBefore = await battleMatchId(firstPage);
  const deadlineBefore = await deadline(firstPage);
  const stateBeforeRestart = await roomSnapshot(firstReconnect, room.roomId);
  const guestProgressBefore = snapshotPlayer(stateBeforeRestart, guestIdentity).progress;
  const guestHpBefore = snapshotPlayer(stateBeforeRestart, guestIdentity).hp;
  const hostSpellsBefore = snapshotPlayer(stateBeforeRestart, hostIdentity).spellsCast;
  expect(guestHpBefore).toBeLessThan(INITIAL_HEALTH);

  await host.context.close();
  await firstReconnect.close();
  await harness().restartServer();

  const hostAfter = await newContext(browser);
  const hostPageAfter = await hostAfter.newPage();
  await gotoApp(hostPageAfter, '/');
  await signIn(hostPageAfter, hostIdentity.username);
  await gotoApp(hostPageAfter, `/?room=${room.roomId}`);
  const guestAfter = await newContext(browser);
  const guestPageAfter = await guestAfter.newPage();
  await gotoApp(guestPageAfter, '/');
  await signIn(guestPageAfter, guestName);
  await gotoApp(guestPageAfter, `/?room=${room.roomId}`);
  await Promise.all([waitForCombat(hostPageAfter, 90_000), waitForCombat(guestPageAfter, 90_000)]);

  expect(await battleMatchId(guestPageAfter)).toBe(matchIdBefore);
  expect(await battleMatchId(hostPageAfter)).toBe(matchIdBefore);
  // The deadline is one absolute instant: reactivation neither resets nor extends it.
  expect(await deadline(guestPageAfter)).toBe(deadlineBefore);
  const afterRestart = await roomSnapshot(hostAfter, room.roomId);
  expect(afterRestart.startedAt).toBe(stateBeforeRestart.startedAt);
  expect(snapshotPlayer(afterRestart, guestIdentity).progress).toBeGreaterThanOrEqual(
    guestProgressBefore,
  );
  expect(snapshotPlayer(afterRestart, guestIdentity).hp).toBe(guestHpBefore);
  expect(snapshotPlayer(afterRestart, hostIdentity).spellsCast).toBe(hostSpellsBefore);

  // Play resumes from the server's own state: the same book continues and the next completion lands.
  const resumeText = await spellText(hostPageAfter);
  expect(book).toContain(resumeText);
  await completeSpell(hostPageAfter);
  await expect
    .poll(
      async () => snapshotPlayer(await roomSnapshot(hostAfter, room.roomId), guestIdentity).hp,
      { timeout: 30_000 },
    )
    .toBe(guestHpBefore - completionDamage(resumeText));
  expect(await battlePhase(hostPageAfter)).toBe('playing');
  await expect(guestPageAfter.getByTestId('connection-status')).toHaveAttribute(
    'data-state',
    'open',
  );
  // The reconnected player's own arena shows the same, freshly dealt health.
  expect(await seatHealth(guestPageAfter, guestIdentity.userId)).toEqual({
    hp: guestHpBefore - completionDamage(resumeText),
    maxHp: INITIAL_HEALTH,
  });

  await hostAfter.close();
  await guestAfter.close();
});
