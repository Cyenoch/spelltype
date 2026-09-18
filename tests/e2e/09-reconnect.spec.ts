/**
 * Spec 9 — disconnects: the match never freezes, seats, health and the accepted draft survive a
 * reconnect, the absolute deadline is never extended, and host control moves to a connected player.
 */
import { expect, test } from '../support/test';
import { INITIAL_HEALTH, type RoomSnapshot } from '../../shared/protocol';
import { acceptedGeneration, fixture, restartInstance } from '../support/runtime';
import {
  arenaSeat,
  battleMatchId,
  battlePhase,
  completeSpell,
  completionDamage,
  deadline,
  hitSeq,
  hitsRendered,
  inputState,
  inputValue,
  roomSnapshot,
  seatHealth,
  snapshotPlayer,
  selfSpellIndex,
  selfProgress,
  spellText,
  timerRemaining,
  typeText,
  typingEffects,
  waitForCombat,
  waitForHit,
  waitForSpell,
} from '../support/combat';
import {
  apiJson,
  createRoom,
  gotoApp,
  newContext,
  occupiedSeats,
  selfIdentity,
  settle,
  setReady,
  signIn,
  signedInContext,
  startMatch,
  testId,
  twoPlayerRoom,
  waitForLobbyPlayers,
} from '../support/ui';

test.beforeEach(async () => {
  await fixture().reset();
  await fixture().scenario({ mode: 'success' });
});

test('对手断线不冻结比赛，重连与进程重启后恢复席位、血量与已接受草稿', async ({ browser }) => {
  test.setTimeout(900_000);
  const room = await twoPlayerRoom(browser, { theme: '断线契约', difficulty: 'hard' });
  const host = room.host;
  const guest = room.guest;
  const guestIdentity = await selfIdentity(guest.context);
  const hostIdentity = await selfIdentity(host.context);
  const guestName = guestIdentity.username;
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guest.page)]);

  const { generation } = acceptedGeneration(await fixture().state());
  const firstSpell = generation.texts[0];
  const liveMatchId = await battleMatchId(host.page);
  const combatDeadline = await deadline(host.page);

  // The guest commits a prefix, which the host can see, then drops off the network entirely.
  await typeText(guest.page, firstSpell.slice(0, 5));
  await expect
    .poll(async () => snapshotPlayer(await roomSnapshot(host.context, room.roomId), guestIdentity).progress, { timeout: 20_000 })
    .toBe(5);
  await expect.poll(async () => (await arenaSeat(host.page, guestIdentity.userId).getAttribute('data-connected')) ?? '').toBe('true');
  await guest.context.close();

  // The remaining player keeps a live, decreasing clock instead of a frozen match.
  const before = await timerRemaining(host.page);
  await settle(2500);
  const after = await timerRemaining(host.page);
  expect(after).toBeLessThan(before - 1000);
  expect(await testId(host.page, 'arena-seat').count()).toBe(2);
  expect(await battlePhase(host.page)).toBe('playing');

  // The disconnected player keeps their seat, their accepted prefix and their health; only the
  // connection flag changes.
  await expect
    .poll(async () => snapshotPlayer(await roomSnapshot(host.context, room.roomId), guestIdentity).connected, { timeout: 20_000 })
    .toBe(false);
  const during = await roomSnapshot(host.context, room.roomId);
  expect(during.matchId).toBe(liveMatchId);
  expect(during.players).toHaveLength(2);
  expect(snapshotPlayer(during, guestIdentity).progress).toBe(5);
  expect(snapshotPlayer(during, guestIdentity).hp).toBe(INITIAL_HEALTH);

  // The match keeps moving without the opponent: real completions still land on the absent target.
  await completeSpell(host.page);
  const damaged = await roomSnapshot(host.context, room.roomId);
  expect(snapshotPlayer(damaged, guestIdentity).hp).toBe(INITIAL_HEALTH - completionDamage(firstSpell));
  expect(snapshotPlayer(damaged, guestIdentity).progress).toBe(5);
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
  const restored = await apiJson<RoomSnapshot>(firstReconnect, `/api/rooms/${room.roomId}`);
  expect(restored.body.selfInput).toBe(firstSpell.slice(0, 5));
  const hostView = await apiJson<RoomSnapshot>(host.context, `/api/rooms/${room.roomId}`);
  expect(hostView.body.selfInput).not.toBe(restored.body.selfInput);
  expect(snapshotPlayer(restored.body, guestIdentity).hp).toBe(INITIAL_HEALTH - completionDamage(firstSpell));

  // The draft is a real accepted prefix: completing the rest of it finishes the spell.
  const completedText = await completeSpell(firstPage);
  expect(completedText).toBe(firstSpell);
  const afterGuestCast = await roomSnapshot(host.context, room.roomId);
  expect(snapshotPlayer(afterGuestCast, hostIdentity).hp).toBe(INITIAL_HEALTH - completionDamage(firstSpell));
  expect(await battlePhase(host.page)).toBe('playing');

  // Durable Object reactivation: both clients disconnect, the application process is restarted
  // (same port, same persist directory, no production test hooks), and the running match must
  // survive with its identity, its absolute deadline and every player's accepted state.
  const matchIdBefore = await battleMatchId(firstPage);
  const deadlineBefore = await deadline(firstPage);
  const phaseBefore = await battlePhase(firstPage);
  const stateBeforeRestart = await roomSnapshot(firstReconnect, room.roomId);
  const guestProgressBefore = snapshotPlayer(stateBeforeRestart, guestIdentity).progress;
  const guestHpBefore = snapshotPlayer(stateBeforeRestart, guestIdentity).hp;
  const hostSpellsBefore = snapshotPlayer(stateBeforeRestart, hostIdentity).spellsCast;
  expect(phaseBefore).toBe('playing');
  expect(guestHpBefore).toBeLessThan(INITIAL_HEALTH);

  await host.context.close();
  await firstReconnect.close();
  await restartInstance('app');

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
  expect(await deadline(hostPageAfter)).toBe(deadlineBefore);
  const afterRestart = await roomSnapshot(hostAfter, room.roomId);
  expect(afterRestart.matchId).toBe(matchIdBefore);
  expect(afterRestart.startedAt).toBe(stateBeforeRestart.startedAt);
  expect(snapshotPlayer(afterRestart, guestIdentity).progress).toBeGreaterThanOrEqual(guestProgressBefore);
  expect(snapshotPlayer(afterRestart, guestIdentity).hp).toBe(guestHpBefore);
  expect(snapshotPlayer(afterRestart, hostIdentity).spellsCast).toBe(hostSpellsBefore);
  expect(snapshotPlayer(afterRestart, hostIdentity).damageDealt).toBe(stateBeforeRestart.players.find((player) => player.id === hostIdentity.userId)!.damageDealt);

  // Play resumes from the server's own state: the same spell continues and the next completion lands.
  await waitForSpell(hostPageAfter, await selfSpellIndex(hostPageAfter));
  const resumeText = await spellText(hostPageAfter);
  const guestHpResume = snapshotPlayer(await roomSnapshot(hostAfter, room.roomId), guestIdentity).hp;
  await completeSpell(hostPageAfter);
  const guestHpAfter = guestHpResume - completionDamage(resumeText);
  await expect
    .poll(async () => snapshotPlayer(await roomSnapshot(hostAfter, room.roomId), guestIdentity).hp, { timeout: 30_000 })
    .toBe(guestHpAfter);
  expect(await battlePhase(hostPageAfter)).toBe('playing');
  await expect(testId(guestPageAfter, 'connection-status')).toHaveAttribute('data-state', 'open');
  // The reconnected player's own arena shows the same, freshly dealt health.
  expect(await seatHealth(guestPageAfter, guestIdentity.userId)).toEqual({ hp: guestHpAfter, maxHp: INITIAL_HEALTH });

  await hostAfter.close();
  await guestAfter.close();
});

test('房主在大厅离开后由其他已连接玩家接任并可开局', async ({ browser }) => {
  test.setTimeout(420_000);
  const host = await signedInContext(browser, 'mig0');
  const roomId = await createRoom(host.page, { theme: '接任契约', difficulty: 'easy' });
  const first = await signedInContext(browser, 'mig1');
  const second = await signedInContext(browser, 'mig2');
  const firstIdentity = await selfIdentity(first.context);
  const secondIdentity = await selfIdentity(second.context);

  await gotoApp(first.page, `/?room=${roomId}`);
  await gotoApp(second.page, `/?room=${roomId}`);
  await waitForLobbyPlayers(host.page, [host.username, first.username, second.username]);
  await setReady(first.page, true);
  await setReady(second.page, true);

  const departedHostId = (await selfIdentity(host.context)).userId;
  await host.context.close();

  let hostId = '';
  await expect
    .poll(
      async () => {
        hostId = (await apiJson<RoomSnapshot>(first.context, `/api/rooms/${roomId}`)).body.hostId;
        return hostId === firstIdentity.userId || hostId === secondIdentity.userId;
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  const successor = hostId === firstIdentity.userId ? first : second;
  const follower = successor === first ? second : first;

  // The seat of the player who left by closing the browser stays reserved for a grace period.
  // While it is there the room must refuse to start, and the hint must name the seat it waits for.
  await expect(testId(successor.page, 'lobby-start')).toBeDisabled();
  await expect(testId(successor.page, 'lobby-hint')).toContainText(host.username);
  await expect(occupiedSeats(successor.page)).toHaveCount(3);

  // After the grace expires the stale seat is reclaimed and starting becomes possible.
  await expect(testId(successor.page, 'lobby-start')).toBeEnabled({ timeout: 180_000 });
  await expect(occupiedSeats(successor.page)).toHaveCount(2);
  const reclaimed = await apiJson<RoomSnapshot>(follower.context, `/api/rooms/${roomId}`);
  expect(reclaimed.body.players).toHaveLength(2);
  expect(reclaimed.body.players.every((player) => player.connected)).toBe(true);
  expect(reclaimed.body.players.some((player) => player.id === departedHostId)).toBe(false);

  await testId(successor.page, 'lobby-start').click();
  await Promise.all([waitForCombat(successor.page), waitForCombat(follower.page)]);
  const text = await spellText(successor.page);
  expect(await spellText(follower.page)).toBe(text);
  await typeText(successor.page, text.slice(0, 3));
  const successorIdentity = successor === first ? firstIdentity : secondIdentity;
  await expect
    .poll(() => roomSnapshot(follower.context, roomId).then((snapshot) => snapshotPlayer(snapshot, successorIdentity).progress), { timeout: 20_000 })
    .toBe(3);

  await first.context.close();
  await second.context.close();
});

test('刷新重连进入进行中的比赛会立刻恢复已接受草稿，且不重放历史命中', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await twoPlayerRoom(browser, { theme: '草稿恢复契约', difficulty: 'hard' });
  const host = room.host;
  const guest = room.guest;
  const hostIdentity = await selfIdentity(host.context);
  const guestIdentity = await selfIdentity(guest.context);
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guest.page)]);

  // One real hit lands first: the room's event ring is non-empty, so a page that reloads into this
  // match has a history it must render as state instead of replaying as an animation.
  const firstSpell = await spellText(host.page);
  expect(await completeSpell(host.page)).toBe(firstSpell);
  const guestHpAfterHit = (await seatHealth(host.page, guestIdentity.userId)).hp;
  expect(guestHpAfterHit).toBe(INITIAL_HEALTH - completionDamage(firstSpell));
  const eventsBefore = (await roomSnapshot(host.context, room.roomId)).events.length;
  expect(eventsBefore).toBeGreaterThan(0);

  // The guest commits a prefix of their own first spell and then reloads straight back into the
  // running match. The server holds that accepted draft, so the page must come back showing it.
  const guestSpell = await spellText(guest.page);
  const draft = guestSpell.slice(0, 6);
  await typeText(guest.page, draft);
  await expect.poll(async () => (await roomSnapshot(guest.context, room.roomId)).selfInput).toBe(draft);

  await guest.page.reload();
  await waitForCombat(guest.page);

  // The accepted draft is shown immediately: the meter reports the confirmed prefix and the field
  // is in the typing state rather than an idle zero.
  await expect.poll(async () => (await selfProgress(guest.page)).accepted).toBe(draft.length);
  expect(await inputValue(guest.page)).toBe(draft);
  expect(await inputState(guest.page)).toBe('typing');
  const meter = await selfProgress(guest.page);
  expect(meter.length).toBe([...guestSpell].length);
  expect(meter.percent).toBeGreaterThan(0);

  // Nothing from the history is animated: the room still holds that earlier hit, and the freshly
  // mounted arena has replayed none of it, nor started an effect loop.
  expect((await roomSnapshot(guest.context, room.roomId)).events.length).toBe(eventsBefore);
  expect(await hitSeq(guest.page)).toBe(0);
  expect(await hitsRendered(guest.page)).toBe(0);
  const effectsAfterReload = await typingEffects(guest.page);
  await settle(1500);
  expect(await typingEffects(guest.page)).toBe(effectsAfterReload);

  // The restored draft is a real accepted prefix: completing it deals exactly one completion's
  // worth of damage, and the impact that follows is what the arena animates.
  const hostHpBefore = (await seatHealth(guest.page, hostIdentity.userId)).hp;
  expect(await completeSpell(guest.page)).toBe(guestSpell);
  await expect
    .poll(async () => (await seatHealth(guest.page, hostIdentity.userId)).hp, { timeout: 30_000 })
    .toBe(hostHpBefore - completionDamage(guestSpell));
  await waitForHit(guest.page, 1);
  expect(await hitsRendered(guest.page)).toBeGreaterThanOrEqual(1);

  await host.context.close();
  await guest.context.close();
});
