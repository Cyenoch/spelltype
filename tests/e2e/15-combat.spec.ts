/**
 * Spec 15 — the combat rules the room is authoritative for, driven against the real Durable
 * Object: the 24-spell book and its wrap, atomic once-per-completion damage, immediate advance
 * without waiting for an opponent, and what happens to a player who has been eliminated.
 *
 * Every completion is typed through the real input field (there is no timing or scoring back
 * door), and every assertion reads what the players can observe: the arena DOM, the public room
 * snapshot and — for input that the client itself would refuse — raw frames on a real socket.
 */
import { expect, test } from '../support/test';
import { INITIAL_HEALTH, MATCH_DURATION_MS, SPELL_BOOK_SIZE, type RoomSnapshot } from '../../shared/protocol';
import { acceptedGeneration, fixture } from '../support/runtime';
import {
  arenaSeat,
  battleMatchId,
  battlePhase,
  combatLog,
  completeSpell,
  completionDamage,
  defeatSeat,
  endReason,
  finalRows,
  hitsRendered,
  inputValue,
  playUntilFinished,
  resultBanner,
  seatHealth,
  seatIsOut,
  seatOrder,
  selfSpellIndex,
  selfSpellsCast,
  snapshotPlayer,
  spellElement,
  spellText,
  targetSeat,
  timerRemaining,
  typingInput,
  waitForCombat,
  waitForHit,
  waitForSpell,
} from '../support/combat';
import {
  apiJson,
  capturedText,
  receivedText,
  rowFor,
  seatedRoom,
  selfIdentity,
  sendRawMessages,
  settle,
  startMatch,
  testId,
  twoPlayerRoom,
} from '../support/ui';

test.beforeEach(async () => {
  await fixture().reset();
  await fixture().scenario({ mode: 'success' });
});

test('咒文按序下发、第25篇回到第1篇，全本与对手进度从不被提前下发', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await twoPlayerRoom(browser, { theme: '咒文书契约', difficulty: 'easy', sockets: true });
  const host = room.host.page;
  const guest = room.guest.page;
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  const { request, generation } = acceptedGeneration(await fixture().state());
  const book = generation.texts;
  // The room accepts nothing but one full book of distinct in-band spells, so this accepted payload
  // is a complete 24-spell book; the assertions below pin what the fixture actually sent.
  expect(request.difficulty).toBe('easy');
  expect(request.askedCount).toBe(SPELL_BOOK_SIZE);
  expect(request.returnedCount).toBe(SPELL_BOOK_SIZE);
  expect(request.distinctTexts).toBe(true);
  expect(new Set(book).size).toBe(SPELL_BOOK_SIZE);
  for (const text of book) {
    const length = [...text].length;
    expect(length).toBeGreaterThanOrEqual(request.lengthRange[0]);
    expect(length).toBeLessThanOrEqual(request.lengthRange[1]);
  }
  // Precondition of the wrap below: walking all 24 easy spells must not kill the target, so the
  // cursor really reaches index 24 instead of the match ending on an elimination.
  const bookDamage = book.reduce((sum, text) => sum + completionDamage(text), 0);
  expect(bookDamage).toBeLessThan(INITIAL_HEALTH);

  const observed: string[] = [];
  for (let index = 0; index < SPELL_BOOK_SIZE; index += 1) {
    await waitForSpell(host, index);
    const text = await spellText(host);
    expect(text).toBe(book[index]);
    // The opponent has completed nothing, so their own cursor is still on the first spell.
    expect(await selfSpellIndex(guest)).toBe(0);
    expect(await spellText(guest)).toBe(book[0]);
    await completeSpell(host);
    observed.push(text);
  }
  expect(observed).toEqual(book);

  // Index 24 wraps onto the first distinct spell — repeated practice, not a dead end and not a
  // second generation request.
  await waitForSpell(host, SPELL_BOOK_SIZE);
  expect(await spellText(host)).toBe(book[0]);
  expect(await selfSpellsCast(host)).toBe(SPELL_BOOK_SIZE);
  expect((await fixture().state()).generations).toHaveLength(1);

  // Damage is exactly four per code point of the spells that were actually completed.
  const guestSeat = await seatHealth(host, guestIdentity.userId);
  expect(guestSeat.maxHp).toBe(INITIAL_HEALTH);
  expect(guestSeat.hp).toBe(INITIAL_HEALTH - bookDamage);
  expect((await seatHealth(guest, guestIdentity.userId)).hp).toBe(INITIAL_HEALTH - bookDamage);
  expect(await seatIsOut(host, guestIdentity.userId)).toBe(false);

  const hostFrames = receivedText(room.hostSockets!);
  expect(hostFrames).toContain(book[0]);
  // No single server frame ever carries more than the one spell its recipient has reached.
  for (const frame of capturedText(room.hostSockets!).split('\n')) {
    const leaked = book.filter((text) => frame.includes(text));
    expect(new Set(leaked).size, `frame carried more than one book spell: ${frame.slice(0, 160)}`).toBeLessThanOrEqual(1);
  }
  // The opponent never receives a spell they have not reached themselves.
  const guestFrames = receivedText(room.guestSockets!);
  expect(guestFrames).toContain(book[0]);
  for (const text of book.slice(1)) expect(guestFrames).not.toContain(text);

  await room.host.context.close();
  await room.guest.context.close();
});

test('重复提交同一篇咒文不会二次结算伤害', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await twoPlayerRoom(browser, { theme: '结算契约', difficulty: 'hard' });
  const host = room.host.page;
  const guest = room.guest.page;
  const guestIdentity = await selfIdentity(room.guest.context);
  const hostIdentity = await selfIdentity(room.host.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  const { generation } = acceptedGeneration(await fixture().state());
  const first = generation.texts[0];
  const liveMatchId = await battleMatchId(host);
  expect(liveMatchId.length).toBeGreaterThan(0);
  const damage = completionDamage(first);

  const hpBefore = (await seatHealth(host, guestIdentity.userId)).hp;
  expect(await completeSpell(host)).toBe(first);
  await expect.poll(async () => (await seatHealth(host, guestIdentity.userId)).hp).toBe(hpBefore - damage);
  expect(await selfSpellsCast(host)).toBe(1);

  const log = await combatLog(host);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({ seq: 1, attacker: hostIdentity.userId, target: guestIdentity.userId, damage, eliminated: false });

  const during = await apiJson<RoomSnapshot>(room.guest.context, `/api/rooms/${room.roomId}`);
  const guestHp = snapshotPlayer(during.body, guestIdentity).hp;
  const hostSpells = snapshotPlayer(during.body, hostIdentity).spellsCast;
  const events = during.body.events.length;

  // The live match id with the spell index the room already consumed, twice, plus a forged match
  // id: a replayed packet must never deal damage or move the attacker's counters.
  await sendRawMessages(host, room.roomId, [
    { type: 'input', matchId: liveMatchId, spellIndex: 0, text: first },
    { type: 'input', matchId: liveMatchId, spellIndex: 0, text: first },
    { type: 'input', matchId: '000000000000000000000000', spellIndex: 0, text: first },
  ]);
  await settle(2000);

  const after = await apiJson<RoomSnapshot>(room.guest.context, `/api/rooms/${room.roomId}`);
  expect(snapshotPlayer(after.body, guestIdentity).hp).toBe(guestHp);
  expect(snapshotPlayer(after.body, hostIdentity).spellsCast).toBe(hostSpells);
  expect(snapshotPlayer(after.body, hostIdentity).damageDealt).toBe(damage);
  expect(after.body.events).toHaveLength(events);
  expect(after.body.events.at(-1)!.seq).toBe(1);
  expect(after.body.events.at(-1)!.damage).toBe(damage);

  // The opponent's own view of the log never grew either.
  expect(await combatLog(guest)).toHaveLength(1);

  await room.host.context.close();
  await room.guest.context.close();
});

test('被击败的玩家再也无法造成伤害，出局顺序决定名次', async ({ browser }) => {
  test.setTimeout(600_000);
  const room = await seatedRoom(browser, 3, { theme: '出局契约', difficulty: 'hard' });
  const [first, second, third] = room.sessions;
  const attacker = first;
  const identities = await Promise.all(room.sessions.map((session) => selfIdentity(session.context)));
  const [attackerId] = identities;
  await startMatch(attacker.page);
  await Promise.all(room.sessions.map((session) => waitForCombat(session.page)));

  // Seats are exactly the three real participants, ordered by slot, with no filler seats.
  const seats = await seatOrder(attacker.page);
  expect(seats).toHaveLength(3);
  expect([...seats].sort()).toEqual(identities.map((identity) => identity.userId).sort());
  expect(seats[0]).toBe(attackerId.userId);
  // Automatic targeting: the attacker's target is the next alive seat clockwise from their own.
  const victimId = seats[1];
  const survivorId = seats[2];
  expect(await targetSeat(attacker.page).getAttribute('data-user')).toBe(victimId);

  const { generation } = acceptedGeneration(await fixture().state());
  const practice = generation.texts[0];
  const damage = completionDamage(practice);
  const liveMatchId = await battleMatchId(attacker.page);

  const cast = await defeatSeat(attacker.page, victimId);
  expect(cast).toBeGreaterThan(0);
  // One opponent is down, so the match continues against the other one.
  expect(await battlePhase(attacker.page)).toBe('playing');
  expect(await seatIsOut(attacker.page, victimId)).toBe(true);
  expect(await seatHealth(attacker.page, victimId)).toEqual({ hp: 0, maxHp: INITIAL_HEALTH });
  expect(await seatHealth(attacker.page, survivorId)).toEqual({ hp: INITIAL_HEALTH, maxHp: INITIAL_HEALTH });

  // The defeated player's own view is out of the fight, with the target hidden.
  const defeated = identities[1].userId === victimId ? second : third;
  await expect(testId(defeated.page, 'eliminated-notice')).toHaveAttribute('data-state', 'eliminated');
  await expect(typingInput(defeated.page)).not.toBeEditable();
  expect(await seatIsOut(defeated.page, victimId)).toBe(true);
  expect(await battlePhase(defeated.page)).toBe('playing');

  // A defeated player's completion is exactly the packet the room accepted from them one hit
  // earlier (same match, same index, same text). It must now be refused.
  const survivorHpBefore = (await seatHealth(attacker.page, survivorId)).hp;
  await sendRawMessages(defeated.page, room.roomId, [
    { type: 'input', matchId: liveMatchId, spellIndex: 0, text: practice },
  ]);
  await settle(2000);
  expect((await seatHealth(attacker.page, survivorId)).hp).toBe(survivorHpBefore);
  const afterDeadSend = await apiJson<RoomSnapshot>(attacker.context, `/api/rooms/${room.roomId}`);
  expect(snapshotPlayer(afterDeadSend.body, identities[1]).spellsCast + snapshotPlayer(afterDeadSend.body, identities[2]).spellsCast).toBe(0);
  expect(afterDeadSend.body.events.every((event) => event.attackerId !== victimId)).toBe(true);

  // Differential control: the identical packet from a living player is accepted, so the refusal
  // above is about elimination rather than about the packet being malformed.
  const control = identities[2].userId === survivorId ? third : second;
  const attackerHpBefore = (await seatHealth(attacker.page, attackerId.userId)).hp;
  await sendRawMessages(control.page, room.roomId, [
    { type: 'input', matchId: liveMatchId, spellIndex: 0, text: practice },
  ]);
  await expect.poll(async () => (await seatHealth(attacker.page, attackerId.userId)).hp).toBe(attackerHpBefore - damage);

  // The last opponent falls: the match settles by elimination and the ranks follow the board.
  await playUntilFinished(attacker.page);
  expect(await endReason(attacker.page)).toBe('elimination');
  const rows = await finalRows(attacker.page);
  expect(rows).toHaveLength(3);
  expect(rowFor(rows, identities[0])!.rank).toBe(1);
  // Eliminated players are ranked by elimination time, later elimination first.
  expect(rowFor(rows, identities[2])!.rank).toBe(2);
  expect(rowFor(rows, identities[1])!.rank).toBe(3);
  expect(rowFor(rows, identities[2])!.eliminated).toBe(true);
  expect(rowFor(rows, identities[1])!.eliminated).toBe(true);
  expect(rowFor(rows, identities[0])!.eliminated).toBe(false);
  expect(rowFor(rows, identities[0])!.hp).toBeGreaterThan(0);
  expect(rowFor(rows, identities[0])!.damage).toBeGreaterThan(0);
  expect((await resultBanner(attacker.page)).outcome).toBe('win');
  expect((await resultBanner(attacker.page)).endReason).toBe('elimination');
  expect((await resultBanner(defeated.page)).outcome).toBe('down');

  await first.context.close();
  await second.context.close();
  await third.context.close();
});

test('完成一篇咒文后立即进入下一篇，不等对手作答', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await twoPlayerRoom(browser, { theme: '即时推进契约', difficulty: 'hard' });
  const host = room.host.page;
  const guest = room.guest.page;
  const guestIdentity = await selfIdentity(room.guest.context);
  const hostIdentity = await selfIdentity(room.host.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  const { generation } = acceptedGeneration(await fixture().state());
  const [first, second] = generation.texts;
  const element = await spellElement(host);
  const guestHpBefore = (await seatHealth(host, guestIdentity.userId)).hp;

  const startedAt = Date.now();
  expect(await completeSpell(host)).toBe(first);
  const elapsed = Date.now() - startedAt;

  // The finisher's own next spell is open immediately, with an empty field and an editable one.
  await waitForSpell(host, 1);
  expect(await spellText(host)).toBe(second);
  await expect.poll(() => inputValue(host)).toBe('');
  await expect(typingInput(host)).toBeEditable();
  expect(await selfSpellsCast(host)).toBe(1);

  // The opponent answered nothing and is still on the first spell: their progress is irrelevant
  // to the finisher's, and the clock still has almost the whole match left.
  expect(await selfSpellIndex(guest)).toBe(0);
  expect(await inputValue(guest)).toBe('');
  expect(await spellText(guest)).toBe(first);
  expect(elapsed).toBeLessThan(15_000);
  expect(await timerRemaining(host)).toBeGreaterThan(MATCH_DURATION_MS - 60_000);

  // The hit landed once, on the automatic target, and both participants see the same event.
  expect((await seatHealth(host, guestIdentity.userId)).hp).toBe(guestHpBefore - completionDamage(first));
  const hostLog = await combatLog(host);
  expect(hostLog).toHaveLength(1);
  expect(hostLog[0]).toMatchObject({
    seq: 1,
    attacker: hostIdentity.userId,
    target: guestIdentity.userId,
    damage: completionDamage(first),
    element,
    eliminated: false,
  });
  const guestLog = await combatLog(guest);
  expect(guestLog.map((entry) => entry.seq)).toEqual([1]);
  expect(guestLog[0].damage).toBe(completionDamage(first));

  // The arena canvas really animated that impact rather than merely receiving the event.
  await waitForHit(host, 1);
  expect(await hitsRendered(host)).toBeGreaterThanOrEqual(1);

  await room.host.context.close();
  await room.guest.context.close();
});

test('玩家座位与目标标记按座位顺时针推进，且没有多余席位', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await seatedRoom(browser, 4, { theme: '座位契约', difficulty: 'hard' });
  const identities = await Promise.all(room.sessions.map((session) => selfIdentity(session.context)));
  await startMatch(room.sessions[0].page);
  await Promise.all(room.sessions.map((session) => waitForCombat(session.page)));

  const order = await seatOrder(room.sessions[0].page);
  expect(order).toHaveLength(4);
  expect(order).toEqual(identities.map((identity) => identity.userId));

  // Each player's target mark points at the next seat clockwise; nothing targets an empty seat.
  for (const [slot, session] of room.sessions.entries()) {
    const expected = identities[(slot + 1) % identities.length].userId;
    await expect.poll(async () => (await targetSeat(session.page).getAttribute('data-user')) ?? '').toBe(expected);
  }
  for (const session of room.sessions) {
    await expect(arenaSeat(session.page, identities[(0 + 1) % 4].userId)).toHaveCount(1);
    expect(await arenaSeat(session.page, 'ffffffffffffffffffffffff').count()).toBe(0);
    // Nobody has typed, so every seat is at full health and no damage event exists.
    for (const identity of identities) expect((await seatHealth(session.page, identity.userId)).hp).toBe(INITIAL_HEALTH);
  }

  for (const session of room.sessions) await session.context.close();
});
