/**
 * The server-side casting-time gate, observed end to end through real browser surfaces.
 *
 * What only a browser can prove: the enforced floor rejects a premature completion and the field
 * is restored to the exact accepted draft (empty or not, errors preserved, caret at the end); a
 * parked authoritative adoption never disturbs an open IME composition and never resurrects
 * through the trailing input event; the input-overload reset reconnects no earlier than the
 * floor no matter what triggers fire; the protocol-mismatch state is terminal with a reload as
 * the only fix; stored policy and eligibility survive real process restarts untouched; and the
 * whole thing is visible at desktop and mobile viewport sizes.
 *
 * Raw frames here always carry the identity captured from a snapshot at send time; stale
 * identities are sent verbatim on purpose. The scripted-cast test waits out the published
 * `notBefore` — it proves the timing rule is the only barrier, never that a typist is human.
 */
import { expect, type Page } from '@playwright/test';
import { test } from '../support/test';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  INITIAL_HEALTH,
  WS_PROTOCOL,
  type Profile,
  type RoomSnapshot,
} from '../../shared/protocol';
import { combatVolleys, results, rooms } from '../../server/db';
import { breakResultsSink, restoreResultsSink, resultsSinkIsBroken, testDb } from '../support/db';
import { harness } from '../support/harness';
import { apiJson, type Identity, selfIdentity } from '../support/api';
import { gotoApp, settle } from '../support/app';
import {
  backspace,
  battlePhase,
  completeSpell,
  completionDamage,
  deadline,
  gateIndicator,
  inputValue,
  insertIntoField,
  roomSnapshot,
  saveStatus,
  seatHealth,
  selfSpellIndex,
  selfSpellsCast,
  snapshotGate,
  snapshotPlayer,
  spellText,
  typeText,
  typingInput,
  waitForCombat,
  waitForInputGate,
} from '../support/combat';
import { fixture } from '../support/runtime';
import {
  createRoom,
  setReady,
  startMatch,
  twoPlayerRoom,
  waitForLobbyPlayers,
} from '../support/lobby';
import { captureCloseCodes, openRawSocket, receivedText, sentMessages } from '../support/wire';
import { newContext, signIn, signUp, signedInContext, uniqueName } from '../support/session';

/** The one server copy for every version refusal: handshake, room GET and the 4003 frame. */
const UPDATE_REQUIRED = '客户端版本已更新，请刷新页面后继续。';
/** The one server copy announcing a rejection-driven restore. */
const RECOVERY_NOTICE = '输入完成早于本局施法规则，已恢复上一次接受的输入；就绪后请重新补全。';
/** The one server copy for the input-overload reset. */
const OVERLOAD_NOTICE = '输入消息过于密集，连接已重置；正在恢复已保存的输入。';

test.beforeEach(async () => {
  await fixture().reset();
});

/* ------------------------------------------------------------- local helpers */

/** Appends `text` at the field's caret end through one real input event. */
async function insertWholeText(page: Page, text: string): Promise<void> {
  const input = typingInput(page);
  await input.focus();
  await input.evaluate<void, void, HTMLTextAreaElement>((field) => {
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await page.keyboard.insertText(text);
}

/** The caret sits exactly after the last character of the field. */
async function expectCaretAtEnd(page: Page): Promise<void> {
  const position = await typingInput(page).evaluate<
    { start: number | null; end: number | null; length: number },
    void,
    HTMLTextAreaElement
  >((field) => ({
    start: field.selectionStart,
    end: field.selectionEnd,
    length: field.value.length,
  }));
  expect(position.start).toBe(position.length);
  expect(position.end).toBe(position.length);
}

/**
 * Stages a fresh spell whose premature window is open right now. A spell whose floor already
 * passed is completed lawfully (that cast is fine), which rolls a fresh window on the next spell.
 */
async function atPrematureWindow(page: Page, roomId: string, maxSpells = 4): Promise<RoomSnapshot> {
  for (let attempt = 0; attempt < maxSpells; attempt += 1) {
    const snapshot = await roomSnapshot(page.context(), roomId);
    const gate = snapshot.selfInputGate;
    if (snapshot.phase !== 'playing' || snapshot.spell === null || gate === null) {
      await settle(200);
      continue;
    }
    if (snapshot.serverNow < gate.notBefore) return snapshot;
    await completeSpell(page);
  }
  throw new Error('no premature window found within the spell book');
}

/**
 * Guarantees exactly one rejection on this viewer's current spell: completes inside the open
 * premature window and returns once the server's epoch moved. The accepted draft, the stats and
 * both seats' health are untouched by a rejection, which the callers assert on their own.
 */
async function rejectCurrentSpell(
  page: Page,
  roomId: string,
  maxSpells = 4,
): Promise<{ epochBefore: number; snapshot: RoomSnapshot }> {
  for (let attempt = 0; attempt < maxSpells; attempt += 1) {
    const snapshot = await roomSnapshot(page.context(), roomId);
    const gate = snapshot.selfInputGate;
    if (snapshot.phase !== 'playing' || snapshot.spell === null || gate === null) {
      await settle(200);
      continue;
    }
    if (snapshot.serverNow < gate.notBefore) {
      const epochBefore = gate.draftEpoch;
      await typingInput(page).fill(snapshot.spell.text);
      for (let poll = 0; poll < 100; poll += 1) {
        const after = await roomSnapshot(page.context(), roomId);
        const afterGate = after.selfInputGate;
        if (afterGate !== null && afterGate.draftEpoch > epochBefore)
          return { epochBefore, snapshot: after };
        await settle(100);
      }
      throw new Error('premature completion was not rejected');
    }
    await completeSpell(page);
  }
  throw new Error('could not stage a premature completion');
}

/**
 * The observe-mode counterpart: completes inside the premature window and proves the cast was
 * ACCEPTED (spell counter moved) without any epoch bump — recorded, not blocked.
 */
async function acceptPremature(
  page: Page,
  roomId: string,
  identity: Identity,
  maxSpells = 4,
): Promise<RoomSnapshot> {
  const staged = await atPrematureWindow(page, roomId, maxSpells);
  const epochBefore = staged.selfInputGate!.draftEpoch;
  const spellsBefore = snapshotPlayer(staged, identity).spellsCast;
  await insertWholeText(page, staged.spell!.text);
  for (let poll = 0; poll < 100; poll += 1) {
    const after = await roomSnapshot(page.context(), roomId);
    if (
      snapshotPlayer(after, identity).spellsCast > spellsBefore &&
      after.selfInputGate !== null &&
      after.selfInputGate.draftEpoch === epochBefore
    )
      return after;
    await settle(100);
  }
  throw new Error('premature completion was not accepted under observe mode');
}

/** Fires the two reconnect triggers the client listens for, as a focus/online burst would. */
async function fireReconnectTriggers(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

interface TrackedSocket {
  received: string[];
  closed: boolean;
}

/** Counts every WebSocket the page creates from now on, with what each received. */
function trackWebsockets(page: Page): { sockets: TrackedSocket[]; count(): number } {
  const sockets: TrackedSocket[] = [];
  page.on('websocket', (socket) => {
    if (!/^\/api\/rooms\/[0-9a-f]{24}\/ws$/.test(new URL(socket.url()).pathname)) return;
    const entry: TrackedSocket = { received: [], closed: false };
    sockets.push(entry);
    socket.on('framereceived', (event) => entry.received.push(String(event.payload)));
    socket.on('close', () => {
      entry.closed = true;
    });
  });
  return { sockets, count: () => sockets.length };
}

/* ------------------------------------------------------------------ rejects */

test('过早完成被拒绝：恢复已接受草稿、错误保留、光标就位，随后一次命中', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await twoPlayerRoom(browser, { theme: '施法门槛', sockets: true });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  const text = await spellText(host);
  expect(await gateIndicator(host)).toMatchObject({ present: true, mode: 'enforce' });

  // An accepted draft that carries real mistakes: one wrong character typed and taken back
  // leaves the match-cumulative error count at one while the prefix stays correct.
  await typeText(host, text.slice(0, 2));
  await insertIntoField(host, '错');
  await backspace(host, 1);
  await typeText(host, text.slice(2, 4));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress,
    )
    .toBe(4);
  const beforeReject = await roomSnapshot(room.host.context, room.roomId);
  expect(beforeReject.selfInputStats!.errorTotal).toBe(1);
  expect(await inputValue(host)).toBe(text.slice(0, 4));

  // Completing inside the window is refused whole: no damage, no event, no counter moves.
  const rejected = await rejectCurrentSpell(host, room.roomId);
  expect(rejected.epochBefore).toBe(0);
  const afterReject = rejected.snapshot;
  expect(afterReject.selfInputGate!.resetReason).toBe('completion_too_early');
  expect(afterReject.selfInput).toBe(text.slice(0, 4));
  expect(afterReject.selfInputStats!.errorTotal).toBe(1);
  expect(snapshotPlayer(afterReject, guestIdentity).hp).toBe(INITIAL_HEALTH);
  expect(snapshotPlayer(afterReject, guestIdentity).damageDealt).toBe(0);
  expect(afterReject.events).toHaveLength(beforeReject.events.length);

  // The field is exactly the accepted draft again, with the caret after it, and the station
  // explains the restore instead of pretending readiness.
  expect(await inputValue(host)).toBe(text.slice(0, 4));
  await expectCaretAtEnd(host);
  const indicator = await gateIndicator(host);
  expect(indicator.reason).toBe('completion_too_early');
  await expect(host.getByTestId('input-gate-reason')).toHaveText(RECOVERY_NOTICE);
  await expect(host.getByTestId('cast-feedback')).toHaveAttribute('data-state', 'idle');
  await expect(host.getByTestId('battle-tip')).toHaveText('');
  expect(await host.getByTestId('input-status').textContent()).toMatch('本局错误 1 次');

  // The rejection is the viewer's private state: the opponent's snapshot and wire never carry it.
  const guestView = await roomSnapshot(room.guest.context, room.roomId);
  expect(JSON.stringify(guestView)).not.toContain('completion_too_early');
  // The guest's own gate is their own: it never carries the host's bumped epoch or reason.
  expect(guestView.selfInputGate!.resetReason).toBeNull();
  expect(guestView.selfInputGate!.draftEpoch).toBe(0);
  expect(JSON.stringify(guestView.players)).not.toContain('resetReason');
  expect(JSON.stringify(guestView.players)).not.toContain('notBefore');
  expect(receivedText(room.guestSockets!)).not.toContain('completion_too_early');

  // Backwards compatibility of intent: the restored draft is a real accepted prefix, so the
  // lawful completion after the floor lands exactly once.
  await waitForInputGate(host);
  await insertWholeText(host, text.slice(4));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), guestIdentity).hp,
      {
        timeout: 30_000,
      },
    )
    .toBe(INITIAL_HEALTH - completionDamage(text));
  expect(await selfSpellsCast(host)).toBe(1);
  // Exactly one combat event for the one cast, no duplicates from the restore.
  const settled = await roomSnapshot(room.host.context, room.roomId);
  const newEvents = settled.events.filter((event) => event.attackerId === hostIdentity.userId);
  expect(newEvents).toHaveLength(1);
  expect(newEvents[0].damage).toBe(completionDamage(text));

  await room.host.context.close();
  await room.guest.context.close();
});

test('空草稿过早完成恢复为空；等待期内无自动施法，就绪后补全一次命中', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await twoPlayerRoom(browser, { theme: '空草稿门槛', sockets: true });
  const host = room.host.page;
  const guest = room.guest.page;
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  const rejected = await rejectCurrentSpell(host, room.roomId);
  expect(rejected.snapshot.selfInputGate!.resetReason).toBe('completion_too_early');
  // The accepted draft was empty, so the restore is an empty field — never a half completion.
  expect(await inputValue(host)).toBe('');
  expect(rejected.snapshot.selfInput).toBe('');
  expect(snapshotPlayer(rejected.snapshot, guestIdentity).hp).toBe(INITIAL_HEALTH);

  // While the floor holds, nothing moves by itself: no auto packet, no damage, no advance.
  const inputsDuring = sentMessages(room.hostSockets!).filter((frame) => frame.type === 'input');
  await waitForInputGate(host);
  expect(await inputValue(host)).toBe('');
  expect(await selfSpellIndex(host)).toBe(0);
  const afterWait = await roomSnapshot(room.host.context, room.roomId);
  expect(snapshotPlayer(afterWait, guestIdentity).hp).toBe(INITIAL_HEALTH);
  expect(afterWait.events).toHaveLength(rejected.snapshot.events.length);
  const inputsAfterWait = sentMessages(room.hostSockets!).filter((frame) => frame.type === 'input');
  expect(inputsAfterWait).toHaveLength(inputsDuring.length);

  // The player's own completion — typing the whole target — is what lands the hit, once.
  await insertWholeText(host, afterWait.spell!.text);
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), guestIdentity).hp,
      {
        timeout: 30_000,
      },
    )
    .toBe(INITIAL_HEALTH - completionDamage(afterWait.spell!.text));
  expect(await selfSpellsCast(host)).toBe(1);

  await room.host.context.close();
  await room.guest.context.close();
});

test('门槛满足后逐字、输入法确认、整段插入与选区替换同样命中', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await twoPlayerRoom(browser, { theme: '等价完成', sockets: true });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  let damaged = 0;
  let eventsSeen = 0;
  const expectGuestHp = async (text: string) => {
    damaged += completionDamage(text);
    await expect
      .poll(
        async () =>
          snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), guestIdentity).hp,
        {
          timeout: 30_000,
        },
      )
      .toBe(INITIAL_HEALTH - damaged);
    // Exactly one new combat event for this caster: no path dealt a double hit.
    const view = await roomSnapshot(room.host.context, room.roomId);
    const mine = view.events.filter((event) => event.attackerId === hostIdentity.userId);
    expect(mine).toHaveLength(eventsSeen + 1);
    expect(mine[mine.length - 1].damage).toBe(completionDamage(text));
    eventsSeen = mine.length;
  };

  // (1) Per-keystroke typing of the whole target.
  const first = await spellText(host);
  await waitForInputGate(host);
  await typeText(host, first);
  await expectGuestHp(first);
  expect(await selfSpellsCast(host)).toBe(1);

  // (2) An IME-staged completion: provisional text is neither judged nor sent; the commit is.
  const second = await spellText(host);
  await waitForInputGate(host);
  await insertIntoField(host, second.slice(0, 2));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress,
    )
    .toBe(2);
  await host.getByTestId('typing-input').click();
  const cdp = await room.host.context.newCDPSession(host);
  await cdp.send('Input.imeSetComposition', {
    text: second.slice(2),
    selectionStart: second.length,
    selectionEnd: second.length,
  });
  await expect.poll(() => inputValue(host)).toBe(second);
  expect(await selfSpellsCast(host)).toBe(1);
  expect(
    sentMessages(room.hostSockets!)
      .filter((frame) => frame.type === 'input')
      .map((frame) => frame.text)
      .join('\n'),
  ).not.toContain(second.slice(2));
  await cdp.send('Input.insertText', { text: second.slice(2) });
  await expectGuestHp(second);
  expect(await selfSpellsCast(host)).toBe(2);

  // (3) The whole target in one input event.
  const third = await spellText(host);
  await waitForInputGate(host);
  await insertWholeText(host, third);
  await expectGuestHp(third);
  expect(await selfSpellsCast(host)).toBe(3);

  // (4) A selection replacement that lands the final character.
  const fourth = await spellText(host);
  await waitForInputGate(host);
  await typeText(host, `${fourth.slice(0, -1)}#`);
  await host.keyboard.press('Shift+ArrowLeft');
  expect(
    await host
      .getByTestId('typing-input')
      .evaluate<number[], void, HTMLTextAreaElement>((field) => [
        field.selectionStart,
        field.selectionEnd,
      ]),
  ).toEqual([fourth.length - 1, fourth.length]);
  await insertIntoField(host, fourth.slice(-1));
  await expectGuestHp(fourth);
  expect(await selfSpellsCast(host)).toBe(4);

  await room.host.context.close();
  await room.guest.context.close();
});

test('恢复与组合输入交错：候选不动、延迟采纳、尾随回放被丢弃，终态不复活', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await twoPlayerRoom(browser, { theme: '输入法恢复', sockets: true });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  /**
   * Types an accepted prefix, opens a real IME composition over it, and runs one real
   * disconnect/reconnect cycle so the reconnect's authoritative adoption lands while the
   * composition is open — it must be parked, never applied into the candidate text. Returns
   * the discarded composition value and the accepted draft it must fall back to.
   */
  const parkRestoreUnderComposition = async (): Promise<{
    committed: string;
    accepted: string;
    errorTotal: number;
  }> => {
    const initial = await roomSnapshot(room.host.context, room.roomId);
    const accepted = initial.selfInput;
    const errorTotal = initial.selfInputStats!.errorTotal + 1;
    await typeText(host, '错');
    await backspace(host, 1);
    expect(await inputValue(host)).toBe(accepted);
    await expect
      .poll(
        async () => (await roomSnapshot(room.host.context, room.roomId)).selfInputStats!.errorTotal,
      )
      .toBe(errorTotal);
    await host.getByTestId('typing-input').click();
    const cdp = await room.host.context.newCDPSession(host);
    const caret = accepted.length;
    await cdp.send('Input.imeSetComposition', {
      text: 'ceshi',
      selectionStart: caret + 5,
      selectionEnd: caret + 5,
    });
    await expect.poll(() => inputValue(host)).toBe(`${accepted}ceshi`);
    await room.host.context.setOffline(true);
    await expect
      .poll(() => host.getByTestId('connection-status').getAttribute('data-state'), {
        timeout: 20_000,
      })
      .not.toBe('open');
    await room.host.context.setOffline(false);
    await expect
      .poll(() => host.getByTestId('connection-status').getAttribute('data-state'), {
        timeout: 30_000,
      })
      .toBe('open');
    // The parked adoption must not have touched the open composition's candidate text.
    expect(await inputValue(host)).toBe(`${accepted}ceshi`);
    return { committed: `${accepted}ceshi`, accepted, errorTotal };
  };

  const framesWithCeshi = (): number =>
    sentMessages(room.hostSockets!).filter(
      (frame) => frame.type === 'input' && (frame.text ?? '').includes('ceshi'),
    ).length;

  // (a) A nonempty discarded composition: the adoption wins at compositionend, the trailing
  // replay of the exact discarded value falls back to the accepted draft, and the real
  // browser-side cancel afterwards is an ordinary no-op.
  const parkA = await parkRestoreUnderComposition();
  await typingInput(host).evaluate<void, string, HTMLTextAreaElement>((field, discarded) => {
    field.dispatchEvent(new Event('compositionend'));
    field.value = discarded;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, parkA.committed);
  expect(await inputValue(host)).toBe(parkA.accepted);
  expect(framesWithCeshi()).toBe(0);
  expect((await roomSnapshot(room.host.context, room.roomId)).selfInputStats!.errorTotal).toBe(
    parkA.errorTotal,
  );
  // Close out the browser-side composition; reverting to the accepted draft counts nothing.
  const cdpA = await room.host.context.newCDPSession(host);
  await cdpA.send('Input.imeSetComposition', {
    text: '',
    selectionStart: parkA.accepted.length,
    selectionEnd: parkA.accepted.length,
  });
  expect(await inputValue(host)).toBe(parkA.accepted);
  expect(framesWithCeshi()).toBe(0);
  // A DIFFERENT next value — the target's true next character — is a real keystroke: judged
  // and sent as usual, so the restore never swallows genuine typing.
  const nextChar = (await roomSnapshot(room.host.context, room.roomId)).spell!.text.slice(
    parkA.accepted.length,
    parkA.accepted.length + 1,
  );
  await insertIntoField(host, nextChar);
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress,
    )
    .toBe(parkA.accepted.length + 1);

  // (b) An empty discarded composition must still restore the accepted draft, not wipe it.
  const parkB = await parkRestoreUnderComposition();
  await typingInput(host).evaluate<void, void, HTMLTextAreaElement>((field) => {
    field.value = '';
    field.dispatchEvent(new Event('compositionend'));
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(await inputValue(host)).toBe(parkB.accepted);
  expect(framesWithCeshi()).toBe(0);
  const cdpB = await room.host.context.newCDPSession(host);
  await cdpB.send('Input.imeSetComposition', {
    text: '',
    selectionStart: parkB.accepted.length,
    selectionEnd: parkB.accepted.length,
  });
  expect(await inputValue(host)).toBe(parkB.accepted);

  // (c) Terminal while composing: the parked text can never be submitted after the match ends.
  const terminalDraft = (await roomSnapshot(room.host.context, room.roomId)).selfInput;
  await host.getByTestId('typing-input').click();
  const cdpC = await room.host.context.newCDPSession(host);
  await cdpC.send('Input.imeSetComposition', {
    text: 'ceshi',
    selectionStart: terminalDraft.length + 5,
    selectionEnd: terminalDraft.length + 5,
  });
  await expect.poll(() => inputValue(host)).toBe(`${terminalDraft}ceshi`);
  await guest.getByTestId('battle-leave').click();
  await expect.poll(() => battlePhase(host), { timeout: 30_000 }).toBe('finished');
  await typingInput(host).evaluate((field) => field.dispatchEvent(new Event('compositionend')));
  await settle(500);
  expect(framesWithCeshi()).toBe(0);
  expect(snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).hp).toBe(
    INITIAL_HEALTH,
  );

  await room.host.context.close();
  await room.guest.context.close();
});

test('同纪元确认不回退本地编辑；连接正常时在线与可见事件不并建连接', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await twoPlayerRoom(browser, { theme: '确认契约', sockets: true });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);
  const text = await spellText(host);
  const tracked = trackWebsockets(host);

  // Two keystrokes in one burst: the first character's acknowledgement must never rewrite the
  // field back to one character once the second has landed locally.
  await typeText(host, text.slice(0, 1));
  await typeText(host, text.slice(1, 2));
  expect(await inputValue(host)).toBe(text.slice(0, 2));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress,
    )
    .toBe(2);
  expect(await inputValue(host)).toBe(text.slice(0, 2));
  const charFrames = sentMessages(room.hostSockets!).filter(
    (frame) => frame.type === 'input' && frame.text === text.slice(0, 2),
  );
  expect(charFrames).toHaveLength(1);

  // The socket is open: the reconnect triggers must not stack a second connection beside it.
  await fireReconnectTriggers(host);
  await settle(1500);
  expect(tracked.count()).toBe(0);
  await expect(host.getByTestId('connection-status')).toHaveAttribute('data-state', 'open');

  await room.host.context.close();
  await room.guest.context.close();
});

test('刷新、第二连接接管与进程重启保持草稿、纪元与资格完全一致', async ({ browser }) => {
  test.setTimeout(600_000);
  const room = await twoPlayerRoom(browser, { theme: '资格一致' });
  const host = room.host;
  const guest = room.guest;
  const hostIdentity = await selfIdentity(host.context);
  const guestIdentity = await selfIdentity(guest.context);
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guest.page)]);

  const text = await spellText(host.page);
  await typeText(host.page, text.slice(0, 4));
  await expect
    .poll(async () => (await roomSnapshot(host.context, room.roomId)).selfInput)
    .toBe(text.slice(0, 4));
  const base = await roomSnapshot(host.context, room.roomId);
  const baseGate = base.selfInputGate!;
  const baseDeadline = base.deadline;

  // Refresh: the same stored identity comes back, the floor is not re-timed.
  await host.page.reload();
  await waitForCombat(host.page);
  expect(await inputValue(host.page)).toBe(text.slice(0, 4));
  const afterReload = await roomSnapshot(host.context, room.roomId);
  expect(afterReload.selfInputGate!.draftEpoch).toBe(baseGate.draftEpoch);
  expect(afterReload.selfInputGate!.notBefore).toBe(baseGate.notBefore);
  expect(afterReload.deadline).toBe(baseDeadline);

  // A second window of the same account takes the seat over; the original window stops for
  // good instead of fighting for the seat.
  const trackedOriginal = trackWebsockets(host.page);
  const secondWindow = await newContext(browser);
  const secondPage = await secondWindow.newPage();
  await gotoApp(secondPage, '/');
  await signIn(secondPage, hostIdentity.username);
  await gotoApp(secondPage, `/?room=${room.roomId}`);
  await waitForCombat(secondPage);
  expect(await inputValue(secondPage)).toBe(text.slice(0, 4));
  const afterTakeover = await roomSnapshot(secondWindow, room.roomId);
  expect(afterTakeover.selfInputGate!.notBefore).toBe(baseGate.notBefore);
  await expect(host.page.getByTestId('room-error')).toContainText('接管');
  await settle(4000);
  expect(trackedOriginal.count()).toBe(0);
  // Takeover is verified. Vite's dev-only restart reloads even terminal pages, which would
  // legitimately reclaim this seat; that is not part of the Worker durability scenario.
  await host.page.close();

  // A real process restart: both pages' sockets die with the process and reconnect on their
  // own; identity, floor and deadline come back as the stored ones, byte for byte.
  await harness().restartServer();
  await expect
    .poll(() => secondPage.getByTestId('connection-status').getAttribute('data-state'), {
      timeout: 120_000,
    })
    .toBe('open');
  await expect
    .poll(() => guest.page.getByTestId('connection-status').getAttribute('data-state'), {
      timeout: 120_000,
    })
    .toBe('open');
  await Promise.all([waitForCombat(secondPage, 120_000), waitForCombat(guest.page, 120_000)]);
  expect(await inputValue(secondPage)).toBe(text.slice(0, 4));
  const afterRestart = await roomSnapshot(secondWindow, room.roomId);
  expect(afterRestart.matchId).toBe(base.matchId);
  expect(afterRestart.selfInputGate!.draftEpoch).toBe(baseGate.draftEpoch);
  expect(afterRestart.selfInputGate!.notBefore).toBe(baseGate.notBefore);
  expect(afterRestart.deadline).toBe(baseDeadline);

  // The preserved eligibility is a real one: the lawful completion after it lands.
  await waitForInputGate(secondPage);
  await insertWholeText(secondPage, text.slice(4));
  await expect
    .poll(
      async () => snapshotPlayer(await roomSnapshot(secondWindow, room.roomId), guestIdentity).hp,
      {
        timeout: 30_000,
      },
    )
    .toBe(INITIAL_HEALTH - completionDamage(text));

  await secondWindow.close();
});

test('输入超限一次4004：在线与可见触发被地板拦住，重连保留资格而非弃赛', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await twoPlayerRoom(browser, { theme: '超限契约' });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);
  const closeLog = await captureCloseCodes(host);
  await host.addInitScript(() => {
    const timing = { attempts: [] as number[], closedAt: 0, triggers: [] as number[] };
    Object.assign(window, { __gateOverloadTiming: timing });
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        if (!/\/rooms\/[^/]+\/ws/.test(String(args[0]))) return;
        timing.attempts.push(Date.now());
        this.addEventListener('close', (event) => {
          if (event.code !== 4004) return;
          timing.closedAt = Date.now();
          for (const delay of [0, 300, 600])
            window.setTimeout(() => {
              timing.triggers.push(Date.now());
              window.dispatchEvent(new Event('online'));
              document.dispatchEvent(new Event('visibilitychange'));
            }, delay);
        });
      }
    };
  });
  await host.reload();
  await waitForCombat(host);
  await expect(host.getByTestId('connection-status')).toHaveAttribute('data-state', 'open');

  const beforeGate = (await roomSnapshot(room.host.context, room.roomId)).selfInputGate!;
  const tracked = trackWebsockets(host);

  // Sixty-one lawful drafts in one quota window through the page's own real socket: the last
  // one is refused, the connection is revoked and closed exactly once with 4004.
  await typingInput(host).evaluate<void, void, HTMLTextAreaElement>((field) => {
    for (let count = 1; count <= 61; count += 1) {
      field.value = 'x'.repeat(count);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await expect.poll(() => closeLog(), { timeout: 20_000 }).toContain(4004);
  await expect(host.getByTestId('battle-notice')).toContainText(OVERLOAD_NOTICE);

  // Measure from native close/constructor events, not from a potentially late Node poll.
  // The in-page close observer also fires online/visibility bursts within the floor.

  // After the floor the room comes back on its own: the same match, the same gate, the draft
  // the server accepted, and no forfeit.
  await expect
    .poll(() => host.getByTestId('connection-status').getAttribute('data-state'), {
      timeout: 15_000,
    })
    .toBe('open');
  const timing = await host.evaluate(
    () =>
      Reflect.get(window, '__gateOverloadTiming') as {
        attempts: number[];
        closedAt: number;
        triggers: number[];
      },
  );
  expect(timing.attempts).toHaveLength(2);
  expect(timing.triggers[0] - timing.closedAt).toBeLessThan(1000);
  expect(timing.attempts[1] - timing.closedAt).toBeGreaterThanOrEqual(1000);
  expect((await closeLog()).filter((code) => code === 4004)).toHaveLength(1);
  expect(tracked.count()).toBe(1);
  await expect(host.getByTestId('battle-notice')).toBeHidden({ timeout: 15_000 });
  const reconnected = await roomSnapshot(room.host.context, room.roomId);
  expect(reconnected.matchId).not.toBeNull();
  expect(reconnected.phase).toBe('playing');
  expect(reconnected.selfInputGate!.draftEpoch).toBe(beforeGate.draftEpoch);
  expect(reconnected.selfInputGate!.notBefore).toBe(beforeGate.notBefore);
  // The reconnection restores the server's accepted draft, not a forfeited seat.
  await expect.poll(() => inputValue(host), { timeout: 15_000 }).toBe(reconnected.selfInput);
  expect(snapshotPlayer(reconnected, hostIdentity).eliminatedAt).toBeNull();
  expect(snapshotPlayer(reconnected, guestIdentity).hp).toBe(INITIAL_HEALTH);
  expect(await seatHealth(guest, guestIdentity.userId)).toEqual({
    hp: INITIAL_HEALTH,
    maxHp: INITIAL_HEALTH,
  });

  await room.host.context.close();
  await room.guest.context.close();
});

test('协议握手：无与错误子协议被拒绝，缺纪元的输入帧按旧协议关闭4003', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await twoPlayerRoom(browser, { theme: '握手契约' });
  const host = room.host.page;
  await waitForLobbyVisible(host);

  // A handshake that cannot name the wire protocol never becomes a socket.
  const withoutProtocol = await openRawSocket(host, room.roomId, { protocols: [] });
  expect(withoutProtocol.opened).toBe(false);
  const wrongProtocol = await openRawSocket(host, room.roomId, { protocols: ['spelltype.v1'] });
  expect(wrongProtocol.opened).toBe(false);
  const currentProtocol = await openRawSocket(host, room.roomId, { holdMs: 300 });
  expect(currentProtocol.opened).toBe(true);

  // A v2-shaped input without its mandatory draft epoch is an old client in disguise: told to
  // refresh once, then closed with the protocol-mismatch code.
  const missingEpoch = await openRawSocket(host, room.roomId, {
    holdMs: 1500,
    send: [{ type: 'input', matchId: '000000000000000000000000', spellIndex: 0, text: 'spell' }],
  });
  expect(missingEpoch.opened).toBe(true);
  expect(missingEpoch.closeCode).toBe(4003);
  expect(missingEpoch.received.join('\n')).toContain(UPDATE_REQUIRED);

  await room.host.context.close();
  await room.guest.context.close();
});

test('初始读取版本不符是终态：刷新按钮出现，网络恢复与可见事件也不重连', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await twoPlayerRoom(browser, { theme: '终态契约' });
  const host = room.host.page;
  const tracked = trackWebsockets(host);
  await room.host.context.route(new RegExp(`/api/rooms/${room.roomId}$`), (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'protocol:mismatch',
        error: UPDATE_REQUIRED,
        protocolVersion: WS_PROTOCOL,
      }),
    }),
  );
  await gotoApp(host, `/?room=${room.roomId}`);

  // The terminal surface offers exactly one fix for the page itself: reload.
  await expect(host.getByTestId('room-error')).toContainText(UPDATE_REQUIRED);
  await expect(host.getByTestId('room-reload')).toBeVisible();
  await expect(host.getByTestId('room-error-retry')).toHaveCount(0);

  // Terminal means terminal: online, focus and visibility triggers never open a socket.
  for (let burst = 0; burst < 4; burst += 1) {
    await fireReconnectTriggers(host);
    await settle(400);
  }
  expect(tracked.count()).toBe(0);
  await room.host.context.unroute(new RegExp(`/api/rooms/${room.roomId}$`));

  await room.host.context.close();
  await room.guest.context.close();
});

test('重启后旧局策略与资格不可变；新局遵循新默认且观察模式只记录不拦截', async ({ browser }) => {
  test.setTimeout(900_000);
  const room = await twoPlayerRoom(browser, { theme: '策略冻结' });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);
  const enforceGate = (await roomSnapshot(room.host.context, room.roomId)).selfInputGate!;
  expect(enforceGate.mode).toBe('enforce');
  const liveDeadline = await deadline(host);

  // The instance reboots with observe as the new default: the running match keeps the policy it
  // was locked with, down to the exact stored floor instant.
  try {
    await harness().restartServer({ inputPolicyMode: 'observe' });
    await expect
      .poll(() => host.getByTestId('connection-status').getAttribute('data-state'), {
        timeout: 90_000,
      })
      .toBe('open');
    await expect
      .poll(() => guest.getByTestId('connection-status').getAttribute('data-state'), {
        timeout: 90_000,
      })
      .toBe('open');
    await Promise.all([waitForCombat(host, 90_000), waitForCombat(guest, 90_000)]);
    const kept = await roomSnapshot(room.host.context, room.roomId);
    const matchAId = kept.matchId!;
    expect(kept.selfInputGate!.mode).toBe('enforce');
    expect(kept.selfInputGate!.policyVersion).toBe(enforceGate.policyVersion);
    expect(kept.selfInputGate!.notBefore).toBe(enforceGate.notBefore);
    expect(kept.deadline).toBe(liveDeadline);

    // The old match still ENFORCES: a premature completion is refused even under an observe config.
    const staged = await atPrematureWindow(host, room.roomId);
    const rejected = await rejectCurrentSpell(host, room.roomId);
    expect(rejected.snapshot.selfInputGate!.resetReason).toBe('completion_too_early');
    expect(snapshotPlayer(rejected.snapshot, hostIdentity).spellsCast).toBe(
      snapshotPlayer(staged, hostIdentity).spellsCast,
    );

    // Settle the frozen match: the leaver's row and the survivor's row are stored under the
    // match's own policy, not the config that happens to be deployed now.
    await guest.getByTestId('battle-leave').click();
    await expect.poll(() => battlePhase(host), { timeout: 30_000 }).toBe('finished');
    await expect.poll(() => saveStatus(host), { timeout: 120_000 }).toBe('saved');

    // A fresh match plays under the new default: observe records the premature attempt and lets
    // the cast land, with zeroed per-match summaries and no recovery.
    const roomB = await twoPlayerRoom(browser, { theme: '观察默认' });
    const hostBIdentity = await selfIdentity(roomB.host.context);
    await startMatch(roomB.host.page);
    await Promise.all([waitForCombat(roomB.host.page), waitForCombat(roomB.guest.page)]);
    const observeGate = (await roomSnapshot(roomB.host.context, roomB.roomId)).selfInputGate!;
    expect(observeGate.mode).toBe('observe');
    expect(observeGate.draftEpoch).toBe(0);
    expect(observeGate.resetReason).toBeNull();
    const accepted = await acceptPremature(roomB.host.page, roomB.roomId, hostBIdentity);
    expect(accepted.selfInputGate!.draftEpoch).toBe(0);
    expect(accepted.selfInputGate!.resetReason).toBeNull();
    expect(snapshotPlayer(accepted, hostBIdentity).spellsCast).toBe(1);

    // The history column names the stored policy per match: the enforce match stayed 执行, the
    // observe match reports its one recorded gate touch, zero recoveries, and no human claim.
    await roomB.guest.page.getByTestId('battle-leave').click();
    await expect.poll(() => saveStatus(roomB.host.page), { timeout: 120_000 }).toBe('saved');
    const profile = await apiJson<Profile>(roomB.host.context, '/api/profile');
    expect(profile.status).toBe(200);
    const enforceProfile = await apiJson<Profile>(room.host.context, '/api/profile');
    const enforceRow = enforceProfile.body.history.find((row) => row.match_id === matchAId);
    expect(enforceRow?.input_policy_mode).toBe('enforce');
    expect(enforceRow?.input_recoveries).toBe(1);
    const observeRow = profile.body.history.find((row) => row.match_id === accepted.matchId);
    expect(observeRow?.input_policy_mode).toBe('observe');
    expect(observeRow?.input_gate_hits).toBe(1);
    expect(observeRow?.input_recoveries).toBe(0);

    await room.host.context.close();
    await room.guest.context.close();
    await roomB.host.context.close();
    await roomB.guest.context.close();
  } finally {
    await harness().restartServer({ inputPolicyMode: 'enforce' });
  }
});

test('战绩只记一次、摘要不串局；存储只有聚合；历史只属于当前账号', async ({ browser }) => {
  test.setTimeout(900_000);
  const room = await twoPlayerRoom(browser, { theme: '持久摘要' });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  // One real rejection gives this match a nonzero summary before anything can be stored.
  const rejected = await rejectCurrentSpell(host, room.roomId);
  const matchA = rejected.snapshot.matchId!;
  expect(rejected.snapshot.selfInputGate!.draftEpoch).toBe(1);

  // Stop before the current spell can kill, observing every committed volley first.
  const guestHp = async () =>
    snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), guestIdentity).hp;
  let lethalHp = await guestHp();
  let castCount = 0;
  while (lethalHp > completionDamage(await spellText(host))) {
    expect(castCount).toBeLessThan(40);
    const power = completionDamage(await spellText(host));
    await completeSpell(host);
    await expect.poll(guestHp).toBe(lethalHp - power);
    lethalHp -= power;
    castCount += 1;
  }
  expect(lethalHp).toBeGreaterThan(0);
  const killingIndex = await selfSpellIndex(host);
  await breakResultsSink();
  try {
    // Acceptance survives a failed sink, but damage and terminal state do not.
    await completeSpell(host);
    expect(await selfSpellIndex(host)).toBe(killingIndex + 1);
    const [pending] = await testDb()
      .select()
      .from(combatVolleys)
      .where(eq(combatVolleys.room_id, room.roomId));
    expect(pending.casts).toHaveLength(1);
    expect(pending.casts[0]).toMatchObject({
      attackerId: hostIdentity.userId,
      spellIndex: killingIndex,
    });
    await expect
      .poll(async () => {
        const [stored] = await testDb()
          .select({ next: rooms.next_alarm_at })
          .from(rooms)
          .where(eq(rooms.id, room.roomId));
        return stored.next;
      })
      .toBeGreaterThan(pending.ends_at);
    expect(await battlePhase(host)).toBe('playing');
    expect(await guestHp()).toBe(lethalHp);
    expect((await roomSnapshot(room.host.context, room.roomId)).persistence).toBe('idle');
  } finally {
    if (await resultsSinkIsBroken()) await restoreResultsSink();
  }

  // The accepted intent settles without another input, including across restart.
  // Changing the default cannot rewrite the measured policy of this existing match.
  try {
    await harness().restartServer({ inputPolicyMode: 'observe' });
    await gotoApp(host, `/?room=${room.roomId}`);
    await expect.poll(() => saveStatus(host), { timeout: 180_000 }).toBe('saved');
    const rowsA = await testDb()
      .select({
        match_id: results.match_id,
        user_id: results.user_id,
        input_policy_version: results.input_policy_version,
        input_policy_mode: results.input_policy_mode,
        input_gate_hits: results.input_gate_hits,
        input_recoveries: results.input_recoveries,
        input_min_completion_ratio: results.input_min_completion_ratio,
      })
      .from(results)
      .where(eq(results.match_id, matchA));
    expect(rowsA).toHaveLength(2);
    const hostA = rowsA.find((row) => row.user_id === hostIdentity.userId)!;
    const guestA = rowsA.find((row) => row.user_id === guestIdentity.userId)!;
    expect(hostA.input_policy_version).toBe('ascii-floor-v1');
    expect(hostA.input_policy_mode).toBe('enforce');
    expect(hostA.input_gate_hits).toBe(1);
    expect(hostA.input_recoveries).toBe(1);
    expect(hostA.input_min_completion_ratio).not.toBeNull();
    expect(hostA.input_min_completion_ratio!).toBeLessThan(1);
    expect(guestA.input_recoveries).toBe(0);
    expect(guestA.input_min_completion_ratio).toBeNull();

    // A second match under the new default keeps its own summaries; nothing blends across matches.
    await roomBrematch(host, guest);
    const matchB = await roomSnapshot(room.host.context, room.roomId).then((view) => view.matchId!);
    expect(matchB).not.toBe(matchA);
    const accepted = await acceptPremature(host, room.roomId, hostIdentity);
    expect(accepted.selfInputGate!.mode).toBe('observe');
    await guest.getByTestId('battle-leave').click();
    await expect.poll(() => saveStatus(host), { timeout: 120_000 }).toBe('saved');

    const rowsAll = await testDb()
      .select({
        match_id: results.match_id,
        user_id: results.user_id,
        input_policy_mode: results.input_policy_mode,
        input_gate_hits: results.input_gate_hits,
      })
      .from(results)
      .where(inArray(results.match_id, [matchA, matchB]));
    expect(rowsAll).toHaveLength(4);
    for (const matchId of [matchA, matchB])
      for (const userId of [hostIdentity.userId, guestIdentity.userId])
        expect(
          rowsAll.filter((row) => row.match_id === matchId && row.user_id === userId),
        ).toHaveLength(1);
    const hostB = rowsAll.find(
      (row) => row.match_id === matchB && row.user_id === hostIdentity.userId,
    )!;
    expect(hostB.input_policy_mode).toBe('observe');
    expect(hostB.input_gate_hits).toBe(1);
    const hostAAgain = rowsAll.find(
      (row) => row.match_id === matchA && row.user_id === hostIdentity.userId,
    )!;
    expect(hostAAgain.input_policy_mode).toBe('enforce');

    // The persisted table carries aggregates only: no draft, trajectory or raw-input column.
    const columns = await testDb()
      .select({ column_name: sql<string>`column_name` })
      .from(sql`information_schema.columns`)
      .where(sql`table_schema = 'public' AND table_name = 'results'`);
    for (const column of columns)
      expect(column.column_name.toLowerCase()).not.toMatch(
        /draft|trajectory|raw_input|keystroke|input_text/,
      );

    // History is private: each account reads exactly its own rows, and a bystander account
    // reads none of them.
    const hostProfile = await apiJson<Profile>(room.host.context, '/api/profile');
    expect(hostProfile.body.history.some((row) => row.match_id === matchA)).toBe(true);
    expect(hostProfile.body.history.some((row) => row.match_id === matchB)).toBe(true);
    const guestProfile = await apiJson<Profile>(room.guest.context, '/api/profile');
    expect(guestProfile.body.history.some((row) => row.match_id === matchA)).toBe(true);
    expect(guestProfile.body.history.some((row) => row.match_id === matchB)).toBe(true);
    const bystander = await signedInContext(browser, 'bystander');
    const bystanderProfile = await apiJson<Profile>(bystander.context, '/api/profile');
    expect(
      bystanderProfile.body.history.some(
        (row) => row.match_id === matchA || row.match_id === matchB,
      ),
    ).toBe(false);

    await room.host.context.close();
    await room.guest.context.close();
    await bystander.context.close();
  } finally {
    await harness().restartServer({ inputPolicyMode: 'enforce' });
  }
});

test('按门槛等待的脚本施法正常生效', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = await twoPlayerRoom(browser, { theme: '脚本合规' });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  // A script that respects the published floor casts like anyone else: it reads its own
  // identity from a snapshot, waits out the server clock, and sends the captured values
  // verbatim. This verifies the timing rule — never that a typist is human.
  let damaged = 0;
  let casts = 0;
  for (let round = 0; round < 2; round += 1) {
    let staged: RoomSnapshot | null = null;
    for (let attempt = 0; attempt < 50 && staged === null; attempt += 1) {
      const view = await roomSnapshot(room.host.context, room.roomId);
      if (view.phase === 'playing' && view.spell !== null && view.selfInputGate !== null)
        staged = view;
      else await settle(150);
    }
    if (staged === null) throw new Error('no castable state found');
    const notBefore = staged.selfInputGate!.notBefore;
    for (;;) {
      const fresh = await roomSnapshot(room.host.context, room.roomId);
      if (fresh.serverNow >= notBefore && fresh.selfInputGate!.notBefore === notBefore) break;
      await settle(120);
    }
    // The raw frame carries exactly the identity this script captured: verbatim, never upgraded.
    await sendCapturedInput(host, room.roomId, {
      matchId: staged.matchId!,
      spellIndex: snapshotPlayer(staged, hostIdentity).spellIndex,
      draftEpoch: staged.selfInputGate!.draftEpoch,
      text: staged.spell!.text,
    });
    damaged += completionDamage(staged.spell!.text);
    casts += 1;
    await expect
      .poll(
        async () =>
          snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), guestIdentity).hp,
        {
          timeout: 30_000,
        },
      )
      .toBe(INITIAL_HEALTH - damaged);
    const advanced = await roomSnapshot(room.host.context, room.roomId);
    expect(snapshotPlayer(advanced, hostIdentity).spellsCast).toBe(casts);
  }

  await room.host.context.close();
  await room.guest.context.close();
});

test('门槛与恢复的可见状态留存桌面与移动截图', async ({ browser }) => {
  test.setTimeout(420_000);
  // Host on the suite's desktop viewport; guest on a phone-sized one (layout proof only — a
  // real device keyboard cannot be emulated).
  const host = await signedInContext(browser, 'gate');
  const roomId = await createRoom(host.page, { theme: '可见契约' });
  const guest = await newContext(browser, { viewport: { width: 390, height: 844 } });
  const guestPage = await guest.newPage();
  await gotoApp(guestPage, '/');
  const guestName = uniqueName('gate');
  await signUp(guestPage, guestName);
  await gotoApp(guestPage, `/?room=${roomId}`);
  await expect(guestPage.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 });
  await waitForLobbyPlayers(host.page, [host.username, guestName]);
  await setReady(guestPage, true);
  await startMatch(host.page);
  await waitForCombat(host.page);
  await waitForCombat(guestPage);

  const guestIdentity = await selfIdentity(guest);
  const text = await spellText(host.page);

  // Desktop: the recovery notice, the restored draft, the caret, and an editable field.
  await typeText(host.page, text.slice(0, 4));
  const rejected = await rejectCurrentSpell(host.page, roomId);
  expect(await inputValue(host.page)).toBe(text.slice(0, 4));
  await expect(host.page.getByTestId('input-gate-reason')).toHaveText(RECOVERY_NOTICE);
  expect(await host.page.getByTestId('spell-text-complete').count()).toBe(0);
  await expectCaretAtEnd(host.page);
  const desktopShot = test.info().outputPath('input-gate-desktop-1440x900.png');
  await host.page.screenshot({ path: desktopShot });

  // The field is still an ordinary editor after the restore: the next keystroke is judged.
  await insertIntoField(host.page, text.slice(4, 5));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(host.context, roomId), await selfIdentity(host.context))
          .progress,
    )
    .toBe(5);

  // Mobile: the same room shows its own gate inside the phone viewport.
  await expect
    .poll(async () => snapshotGate(await roomSnapshot(guest, roomId), guestIdentity))
    .not.toBeNull();
  await expect(guestPage.getByTestId('input-gate')).toBeVisible();
  await guestPage.getByTestId('input-gate').scrollIntoViewIfNeeded();
  await expect
    .poll(async () => {
      const box = await guestPage.getByTestId('input-gate').boundingBox();
      return box !== null && box.width > 0 && box.x >= 0 && box.x + box.width <= 390;
    })
    .toBe(true);
  const mobileShot = test.info().outputPath('input-gate-mobile-390x844.png');
  await guestPage.screenshot({ path: mobileShot });

  // No duplicate hit: the recovered draft completes once and damages exactly once.
  await waitForInputGate(host.page);
  await insertWholeText(host.page, rejected.snapshot.spell!.text.slice(5));
  await expect(host.page.getByTestId('spell-text-complete')).toBeVisible();
  const expectedHp = INITIAL_HEALTH - completionDamage(rejected.snapshot.spell!.text);
  await expect
    .poll(async () => snapshotPlayer(await roomSnapshot(host.context, roomId), guestIdentity).hp, {
      timeout: 30_000,
    })
    .toBe(expectedHp);
  await settle(600);
  expect(snapshotPlayer(await roomSnapshot(host.context, roomId), guestIdentity)).toMatchObject({
    hp: expectedHp,
  });

  await host.context.close();
  await guest.close();
});

/* ------------------------------------------------------------ test-local glue */

/** Waits until the lobby is visible (handshake tests only need a seated room, not combat). */
async function waitForLobbyVisible(page: Page): Promise<void> {
  await expect(page.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 });
}

/** Sends one captured input frame verbatim over a fresh raw v2 socket. */
async function sendCapturedInput(
  page: Page,
  roomId: string,
  frame: { matchId: string; spellIndex: number; draftEpoch: number; text: string },
): Promise<void> {
  await openRawSocket(page, roomId, {
    holdMs: 1200,
    send: [{ type: 'input', ...frame }],
  });
}

/** Rematches the settled private room in place (both seats survive a settled match). */
async function roomBrematch(host: Page, guest: Page): Promise<void> {
  await host.getByTestId('rematch').click();
  await Promise.all([
    expect(host.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 }),
    expect(guest.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 }),
  ]);
  await Promise.all([setReady(host, true), setReady(guest, true)]);
  // Either surviving connection can become host after the process restart.
  await startMatch((await host.getByTestId('lobby-start').isVisible()) ? host : guest);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);
}
